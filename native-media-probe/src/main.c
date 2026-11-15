/*
 * Isolated NDL DirectMedia v2 hardware-decoder probe for webOS 5+.
 * API flow follows the public webosbrew/samples NDL DirectMedia example:
 * https://github.com/webosbrew/samples/tree/main/media/ndl/directmedia
 *
 * This probe intentionally tests H.264 video only. It does not touch the web player,
 * Google Drive, audio, subtitles, or the existing Native Probe.
 */
#define NDL_DIRECTMEDIA_API_VERSION 2

#include <SDL.h>
#include <NDL_directmedia.h>

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define VIDEO_WIDTH 1280
#define VIDEO_HEIGHT 720
#define VIDEO_FPS 24
#define MAX_FEED_RETRIES 200
#define FEED_BACKOFF_NS 5000000LL

static void log_line(const char *message) {
    const char *home = getenv("HOME");
    char path[512];
    snprintf(path, sizeof(path), "%s/drive-tv-native-media-probe.log", home ? home : "/tmp");
    FILE *f = fopen(path, "a");
    if (f) {
        fprintf(f, "%s\n", message);
        fclose(f);
    }
    fprintf(stderr, "%s\n", message);
}

static void resource_released(const char *type) {
    char line[256];
    snprintf(line, sizeof(line), "NDL resource released: %s", type ? type : "?");
    log_line(line);
}

/* NDL DirectMedia v2 reports LOADCOMPLETED (0x16) and PLAYING (0x1a)
 * asynchronously. Do not feed access units before LOADCOMPLETED. */
static volatile int g_load_completed = 0;
static volatile int g_playing = 0;

static void media_callback(int type, long long number, const char *value) {
    char line[256];
    snprintf(line, sizeof(line), "NDL event type=%d value=%lld %s",
             type, number, value ? value : "");
    log_line(line);
    if (type == 0x16) g_load_completed = 1;
    if (type == 0x1a) g_playing = 1;
}

static int64_t monotonic_ns(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (int64_t)t.tv_sec * 1000000000LL + t.tv_nsec;
}

static void sleep_ns(int64_t ns) {
    if (ns <= 0) return;
    struct timespec req = {
        .tv_sec = (time_t)(ns / 1000000000LL),
        .tv_nsec = (long)(ns % 1000000000LL)
    };
    while (nanosleep(&req, &req) != 0 && errno == EINTR) {}
}

typedef struct {
    const uint8_t *data;
    size_t size;
    size_t pos;
} h264_reader;

static size_t find_start_code(const uint8_t *data, size_t size, size_t from, int *length) {
    for (size_t i = from; i + 3 <= size; ++i) {
        if (data[i] != 0 || data[i + 1] != 0) continue;
        if (data[i + 2] == 1) {
            *length = 3;
            return i;
        }
        if (i + 4 <= size && data[i + 2] == 0 && data[i + 3] == 1) {
            *length = 4;
            return i;
        }
    }
    *length = 0;
    return size;
}

/* The CI-generated stream has one slice per picture and no B-frames. */
static int next_access_unit(h264_reader *reader, const uint8_t **out, size_t *out_size,
                            int64_t *pts_ns, long frame_index) {
    int code_len = 0;
    size_t start = find_start_code(reader->data, reader->size, reader->pos, &code_len);
    if (start >= reader->size) return 0;

    size_t cursor = start;
    int have_picture = 0;
    while (cursor < reader->size) {
        size_t nal = cursor + (size_t)code_len;
        if (nal >= reader->size) {
            cursor = reader->size;
            break;
        }
        int type = reader->data[nal] & 0x1f;
        int is_slice = type >= 1 && type <= 5;
        if (nal > start) {
            int boundary = (type == 9) ||
                (have_picture && (type == 6 || type == 7 || type == 8)) ||
                (have_picture && is_slice && nal + 1 < reader->size &&
                 (reader->data[nal + 1] & 0x80) != 0);
            if (boundary) break;
        }
        if (is_slice) have_picture = 1;
        int next_len = 0;
        cursor = find_start_code(reader->data, reader->size, nal + 1, &next_len);
        code_len = next_len;
    }

    *out = reader->data + start;
    *out_size = cursor - start;
    *pts_ns = (int64_t)frame_index * 1000000000LL / VIDEO_FPS;
    reader->pos = cursor;
    return *out_size > 0;
}

static int load_sample(const char *path, h264_reader *reader, void **mapping) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        char line[512];
        snprintf(line, sizeof(line), "Cannot open sample.h264: %s", strerror(errno));
        log_line(line);
        return 0;
    }
    struct stat st;
    if (fstat(fd, &st) != 0 || st.st_size <= 0) {
        log_line("sample.h264 is empty or cannot be inspected");
        close(fd);
        return 0;
    }
    *mapping = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (*mapping == MAP_FAILED) {
        log_line("Cannot map sample.h264 into memory");
        return 0;
    }
    reader->data = (const uint8_t *)*mapping;
    reader->size = (size_t)st.st_size;
    reader->pos = 0;
    return 1;
}

static int feed_video(const uint8_t *data, size_t size, int64_t pts_ns) {
    for (int attempt = 0; attempt < MAX_FEED_RETRIES; ++attempt) {
        int rc = NDL_DirectVideoPlay((void *)data, (unsigned int)size,
                                     (long long)(pts_ns / 1000));
        if (rc == 0) return 1;
        sleep_ns(FEED_BACKOFF_NS);
    }
    return 0;
}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;

    char executable[512];
    ssize_t exe_len = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (exe_len <= 0) {
        log_line("Cannot resolve native executable path");
        return 2;
    }
    executable[exe_len] = '\0';
    char *slash = strrchr(executable, '/');
    if (!slash) return 2;
    strcpy(slash + 1, "sample.h264");

    h264_reader reader;
    void *mapping = NULL;
    if (!load_sample(executable, &reader, &mapping)) return 3;

    setenv("EGL_PLATFORM", "wayland", 0);
    setenv("XDG_RUNTIME_DIR", "/tmp/xdg", 0);
    if (SDL_Init(0) != 0) {
        log_line(SDL_GetError());
        munmap(mapping, reader.size);
        return 4;
    }

    const char *app_id = getenv("APPID");
    if (!app_id) app_id = "com.syntropy.drivemediaprobe";
    if (NDL_DirectMediaInit(app_id, resource_released) != 0) {
        char line[512];
        snprintf(line, sizeof(line), "NDL_DirectMediaInit failed: %s", NDL_DirectMediaGetError());
        log_line(line);
        SDL_Quit();
        munmap(mapping, reader.size);
        return 5;
    }
    NDL_DirectMediaSetAppState(NDL_DIRECTMEDIA_APP_STATE_FOREGROUND);

    if (SDL_InitSubSystem(SDL_INIT_VIDEO) != 0) {
        log_line(SDL_GetError());
        NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 6;
    }

    SDL_DisplayMode mode;
    if (SDL_GetCurrentDisplayMode(0, &mode) != 0) {
        log_line("SDL_GetCurrentDisplayMode failed");
        NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 7;
    }

    SDL_Window *window = SDL_CreateWindow("Drive TV Hardware Decoder Test",
        SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
        mode.w, mode.h, SDL_WINDOW_FULLSCREEN);
    if (!window) {
        log_line(SDL_GetError());
        NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 8;
    }
    SDL_Renderer *renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
    if (!renderer) {
        log_line(SDL_GetError());
        SDL_DestroyWindow(window);
        NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 9;
    }
    SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_NONE);
    SDL_SetRenderDrawColor(renderer, 0, 0, 0, 0);
    SDL_RenderClear(renderer);
    SDL_RenderPresent(renderer);

    NDL_DIRECTMEDIA_DATA_INFO_T info = {
        .video = {
            .width = VIDEO_WIDTH,
            .height = VIDEO_HEIGHT,
            .type = NDL_VIDEO_TYPE_H264
        }
    };
    if (NDL_DirectMediaLoad(&info, media_callback) != 0) {
        char line[512];
        snprintf(line, sizeof(line), "NDL_DirectMediaLoad failed: %s", NDL_DirectMediaGetError());
        log_line(line);
        SDL_DestroyRenderer(renderer);
        SDL_DestroyWindow(window);
        NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 10;
    }
    if (NDL_DirectVideoSetArea(0, 0, mode.w, mode.h) != 0) {
        log_line("NDL_DirectVideoSetArea failed");
        failed_cleanup:
        NDL_DirectMediaUnload();
        SDL_DestroyRenderer(renderer);
        SDL_DestroyWindow(window);
        NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 11;
    }
    log_line("NDL LOAD REQUESTED - waiting for asynchronous LOADCOMPLETED event");

    /* Keep the native app alive and pump SDL while the TV's media pipeline loads. */
    int64_t load_deadline = monotonic_ns() + 12000000000LL;
    while (!g_load_completed && monotonic_ns() < load_deadline) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT ||
                (event.type == SDL_KEYDOWN &&
                 (event.key.keysym.sym == SDLK_ESCAPE ||
                  event.key.keysym.sym == SDLK_BACKSPACE))) {
                NDL_DirectMediaUnload();
                SDL_DestroyRenderer(renderer);
                SDL_DestroyWindow(window);
                NDL_DirectMediaQuit();
                SDL_Quit();
                munmap(mapping, reader.size);
                return 0;
            }
        }
        SDL_Delay(20);
    }
    if (!g_load_completed) {
        log_line("TIMEOUT: NDL did not report LOADCOMPLETED within 12 seconds");
        /* Do not close immediately: leave the app alive for log inspection. */
        int64_t diagnostic_until = monotonic_ns() + 30000000000LL;
        while (monotonic_ns() < diagnostic_until) {
            SDL_Event event;
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_QUIT ||
                    (event.type == SDL_KEYDOWN &&
                     (event.key.keysym.sym == SDLK_ESCAPE ||
                      event.key.keysym.sym == SDLK_BACKSPACE))) {
                    diagnostic_until = 0;
                }
            }
            if (diagnostic_until == 0) break;
            SDL_Delay(30);
        }
        NDL_DirectMediaUnload();
        SDL_DestroyRenderer(renderer);
        SDL_DestroyWindow(window);
        NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 12;
    }
    log_line("NDL LOADCOMPLETED - feeding H.264 test pattern to TV hardware decoder");

    const uint8_t *unit = NULL;
    size_t unit_size = 0;
    int64_t pts = 0;
    long frames = 0;
    int failed = 0;
    int64_t clock_origin = 0;

    while (next_access_unit(&reader, &unit, &unit_size, &pts, frames)) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT ||
                (event.type == SDL_KEYDOWN &&
                 (event.key.keysym.sym == SDLK_ESCAPE ||
                  event.key.keysym.sym == SDLK_BACKSPACE))) {
                failed = 2;
                break;
            }
        }
        if (failed == 2) break;

        if (clock_origin == 0) clock_origin = monotonic_ns() - pts;
        sleep_ns(clock_origin + pts - monotonic_ns());

        if (!feed_video(unit, unit_size, pts)) {
            log_line("NDL_DirectVideoPlay stopped accepting video access units");
            failed = 1;
            break;
        }
        frames++;
    }

    if (frames > 0 && !failed) {
        char line[256];
        snprintf(line, sizeof(line), "NDL VIDEO FEED OK - %ld H.264 frames submitted", frames);
        log_line(line);
    } else if (!failed) {
        log_line("No H.264 access units were parsed from sample.h264");
        failed = 1;
    }

    /* Keep the video plane visible long enough for a person to confirm playback. */
    int64_t hold_until = monotonic_ns() + 15000000000LL;
    while (failed != 2 && monotonic_ns() < hold_until) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT ||
                (event.type == SDL_KEYDOWN &&
                 (event.key.keysym.sym == SDLK_ESCAPE ||
                  event.key.keysym.sym == SDLK_BACKSPACE))) {
                failed = 2;
            }
        }
        SDL_Delay(30);
    }

    NDL_DirectMediaUnload();
    NDL_DirectMediaQuit();
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    munmap(mapping, reader.size);
    return failed == 1 ? 11 : 0;
}
