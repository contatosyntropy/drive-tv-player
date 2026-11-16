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
#include <curl/curl.h>
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

typedef struct {
    char data[512];
    size_t size;
} upload_response;

static size_t receive_upload_response(char *data, size_t size, size_t count, void *opaque) {
    upload_response *response = (upload_response *)opaque;
    size_t bytes = size * count;
    if (bytes > sizeof(response->data) - response->size - 1) {
        bytes = sizeof(response->data) - response->size - 1;
    }
    memcpy(response->data + response->size, data, bytes);
    response->size += bytes;
    response->data[response->size] = '\0';
    return size * count;
}

static int upload_diagnostic_log(char *report_id, size_t report_id_size) {
    const char *home = getenv("HOME");
    char path[512];
    snprintf(path, sizeof(path), "%s/drive-tv-native-media-probe.log", home ? home : "/tmp");
    FILE *file = fopen(path, "rb");
    if (!file) return 0;

    char report[24001];
    size_t length = fread(report, 1, sizeof(report) - 1, file);
    fclose(file);
    report[length] = '\0';
    if (length == 0 || length >= sizeof(report) - 1) return 0;

    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return 0;
    CURL *curl = curl_easy_init();
    if (!curl) {
        curl_global_cleanup();
        return 0;
    }
    upload_response response = {{0}, 0};
    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: text/plain; charset=utf-8");
    curl_easy_setopt(curl, CURLOPT_URL, "https://drive-tv-player.contatosyntropy.workers.dev/api/probe-log");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, report);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)length);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive_upload_response);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "DriveTVMediaProbe/1.0");
    CURLcode code = curl_easy_perform(curl);
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);

    int ok = 0;
    if (code == CURLE_OK && status == 201) {
        const char *field = strstr(response.data, "\"id\":\"");
        if (field) {
            field += 6;
            if (strlen(field) >= 8 && report_id_size >= 9) {
                memcpy(report_id, field, 8);
                report_id[8] = '\0';
                ok = 1;
            }
        }
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    curl_global_cleanup();
    return ok;
}

static void draw_text(SDL_Renderer *renderer, const char *text, int center_x,
                      int y, int scale, SDL_Color color);

static void show_failure_report(SDL_Renderer *renderer, int width, int height,
                                const char *report_id) {
    SDL_SetRenderDrawColor(renderer, 70, 12, 18, 255);
    SDL_RenderClear(renderer);
    SDL_Color white = {255, 255, 255, 255};
    SDL_Color pink = {255, 190, 190, 255};
    int scale = width / 180;
    if (scale < 4) scale = 4;
    if (scale > 9) scale = 9;
    draw_text(renderer, "MEDIA PROBE STOPPED", width / 2, height / 3 - 55, scale, white);
    draw_text(renderer, "VIDEO FEED FAILED", width / 2, height / 3 + 20, scale, pink);
    if (report_id && report_id[0]) {
        draw_text(renderer, "REPORT UPLOADED", width / 2, height / 2 + 15, scale, white);
        draw_text(renderer, report_id, width / 2, height / 2 + 85, scale + 2, pink);
        draw_text(renderer, "SEND THIS CODE IN CHAT", width / 2, height / 2 + 160, scale, white);
    } else {
        draw_text(renderer, "REPORT UPLOAD FAILED", width / 2, height / 2 + 25, scale, pink);
        draw_text(renderer, "CHECK NETWORK AND RETRY", width / 2, height / 2 + 100, scale, white);
    }
    draw_text(renderer, "BACK TO EXIT", width / 2, height * 4 / 5, scale, white);
    SDL_RenderPresent(renderer);

    int running = 1;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT ||
                (event.type == SDL_KEYDOWN &&
                 (event.key.keysym.sym == SDLK_ESCAPE ||
                  event.key.keysym.sym == SDLK_BACKSPACE ||
                  event.key.keysym.sym == SDLK_q))) running = 0;
        }
        SDL_Delay(20);
    }
}

static const uint8_t FONT[26][7] = {
    {14,17,17,31,17,17,17}, {30,17,17,30,17,17,30},
    {14,17,16,16,16,17,14}, {30,17,17,17,17,17,30},
    {31,16,16,30,16,16,31}, {31,16,16,30,16,16,16},
    {14,17,16,23,17,17,15}, {17,17,17,31,17,17,17},
    {14,4,4,4,4,4,14}, {7,2,2,2,18,18,12},
    {17,18,20,24,20,18,17}, {16,16,16,16,16,16,31},
    {17,27,21,21,17,17,17}, {17,25,21,19,17,17,17},
    {14,17,17,17,17,17,14}, {30,17,17,30,16,16,16},
    {14,17,17,17,21,18,13}, {30,17,17,30,20,18,17},
    {15,16,16,14,1,1,30}, {31,4,4,4,4,4,4},
    {17,17,17,17,17,17,14}, {17,17,17,17,17,10,4},
    {17,17,17,21,21,21,10}, {17,17,10,4,10,17,17},
    {17,17,10,4,4,4,4}, {31,1,2,4,8,16,31}
};

static void draw_text(SDL_Renderer *renderer, const char *text, int center_x,
                      int y, int scale, SDL_Color color) {
    int length = (int)strlen(text);
    int x = center_x - ((length * 6 - 1) * scale) / 2;
    SDL_SetRenderDrawColor(renderer, color.r, color.g, color.b, color.a);

    for (int i = 0; i < length; i++) {
        char ch = text[i];
        if (ch >= 'a' && ch <= 'z') ch = (char)(ch - 'a' + 'A');
        if (ch < 'A' || ch > 'Z') {
            x += 6 * scale;
            continue;
        }
        const uint8_t *glyph = FONT[ch - 'A'];
        for (int row = 0; row < 7; row++) {
            for (int col = 0; col < 5; col++) {
                if (glyph[row] & (1u << (4 - col))) {
                    SDL_Rect pixel = {x + col * scale, y + row * scale, scale, scale};
                    SDL_RenderFillRect(renderer, &pixel);
                }
            }
        }
        x += 6 * scale;
    }
}

static void show_failure(SDL_Renderer *renderer, int width, int height, const char *message) {
    SDL_SetRenderDrawColor(renderer, 70, 12, 18, 255);
    SDL_RenderClear(renderer);
    SDL_Color white = {255, 255, 255, 255};
    SDL_Color pink = {255, 180, 180, 255};
    int scale = width / 150;
    if (scale < 4) scale = 4;
    if (scale > 12) scale = 12;
    draw_text(renderer, "MEDIA PROBE STOPPED", width / 2, height / 2 - 90, scale, white);
    draw_text(renderer, message, width / 2, height / 2, scale, pink);
    draw_text(renderer, "BACK TO EXIT", width / 2, height / 2 + 90, scale, white);
    SDL_RenderPresent(renderer);
    int running = 1;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT ||
                (event.type == SDL_KEYDOWN &&
                 (event.key.keysym.sym == SDLK_ESCAPE ||
                  event.key.keysym.sym == SDLK_BACKSPACE ||
                  event.key.keysym.sym == SDLK_q))) running = 0;
        }
        SDL_Delay(20);
    }
}


static void show_failure_detail(SDL_Renderer *renderer, int width, int height,
                                const char *detail) {
    SDL_SetRenderDrawColor(renderer, 70, 12, 18, 255);
    SDL_RenderClear(renderer);
    SDL_Color white = {255, 255, 255, 255};
    SDL_Color pink = {255, 190, 190, 255};
    int scale = width / 180;
    if (scale < 3) scale = 3;
    if (scale > 7) scale = 7;
    draw_text(renderer, "MEDIA PROBE STOPPED", width / 2, height / 3, scale, white);
    draw_text(renderer, "NDL LOAD FAILED", width / 2, height / 2 - 30, scale, pink);

    /* Split the native error into short lines so it remains readable on a TV. */
    char line1[33] = {0};
    char line2[33] = {0};
    if (detail && *detail) {
        size_t n = strlen(detail);
        size_t first = n > 32 ? 32 : n;
        memcpy(line1, detail, first);
        if (n > first) {
            size_t second = n - first;
            if (second > 32) second = 32;
            memcpy(line2, detail + first, second);
        }
    } else {
        snprintf(line1, sizeof(line1), "NO ERROR TEXT RETURNED");
    }
    draw_text(renderer, line1, width / 2, height / 2 + 35, scale > 4 ? scale - 1 : scale, white);
    if (line2[0]) draw_text(renderer, line2, width / 2, height / 2 + 75, scale > 4 ? scale - 1 : scale, white);
    draw_text(renderer, "BACK TO EXIT", width / 2, height * 4 / 5, scale, white);
    SDL_RenderPresent(renderer);

    int running = 1;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT ||
                (event.type == SDL_KEYDOWN &&
                 (event.key.keysym.sym == SDLK_ESCAPE ||
                  event.key.keysym.sym == SDLK_BACKSPACE ||
                  event.key.keysym.sym == SDLK_q))) running = 0;
        }
        SDL_Delay(20);
    }
}


/* Persistent diagnostic screen: the TV must not silently return to the launcher. */
static void render_stage(SDL_Renderer *renderer, int width, int height,
                         const char *stage, const char *detail, int progress) {
    SDL_SetRenderDrawColor(renderer, 8, 12, 22, 255);
    SDL_RenderClear(renderer);

    SDL_Color white = {245, 248, 255, 255};
    SDL_Color cyan = {110, 205, 255, 255};
    SDL_Color muted = {170, 185, 205, 255};
    int scale = width / 180;
    if (scale < 3) scale = 3;
    if (scale > 8) scale = 8;

    draw_text(renderer, "DRIVE TV MEDIA TEST", width / 2, height / 4, scale, white);
    draw_text(renderer, stage, width / 2, height / 2 - 35, scale, cyan);
    draw_text(renderer, detail, width / 2, height / 2 + 25, scale > 4 ? scale - 1 : scale, muted);

    int bar_w = width * 2 / 3;
    int bar_h = 14;
    SDL_Rect bg = {(width - bar_w) / 2, height * 3 / 4, bar_w, bar_h};
    SDL_Rect fg = {bg.x, bg.y, bar_w * (progress < 0 ? 0 : (progress > 100 ? 100 : progress)) / 100, bar_h};
    SDL_SetRenderDrawColor(renderer, 48, 60, 78, 255);
    SDL_RenderFillRect(renderer, &bg);
    SDL_SetRenderDrawColor(renderer, 75, 175, 245, 255);
    SDL_RenderFillRect(renderer, &fg);
    draw_text(renderer, "BACK TO EXIT", width / 2, height * 3 / 4 + 45, scale, white);
    SDL_RenderPresent(renderer);
}


static void resource_released(const char *type) {
    char line[256];
    snprintf(line, sizeof(line), "NDL resource released: %s", type ? type : "?");
    log_line(line);
}

/* NDL DirectMedia v2 reports LOADCOMPLETED (0x16) and PLAYING (0x1a)
 * asynchronously. Feed immediately after Load; LOADCOMPLETED is informational. */
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
    size_t unit_start = find_start_code(reader->data, reader->size, reader->pos, &code_len);
    if (unit_start >= reader->size || code_len == 0) {
        reader->pos = reader->size;
        return 0;
    }

    size_t nal_start = unit_start;
    int have_vcl = 0;
    while (nal_start < reader->size) {
        size_t header = nal_start + (size_t)code_len;
        if (header >= reader->size) break;
        int nal_type = reader->data[header] & 0x1f;

        /* AUD marks the beginning of the next access unit. Keep it for the
         * next call, but return the complete previous picture first. */
        if (nal_type == 9 && nal_start > unit_start && have_vcl) {
            *out = reader->data + unit_start;
            *out_size = nal_start - unit_start;
            *pts_ns = (int64_t)frame_index * 1000000000LL / VIDEO_FPS;
            reader->pos = nal_start;
            return *out_size > 0;
        }

        if (nal_type >= 1 && nal_type <= 5) have_vcl = 1;

        int next_len = 0;
        size_t next = find_start_code(reader->data, reader->size,
                                      header + 1, &next_len);
        if (next >= reader->size || next_len == 0) {
            reader->pos = reader->size;
            if (!have_vcl) return 0;
            *out = reader->data + unit_start;
            *out_size = reader->size - unit_start;
            *pts_ns = (int64_t)frame_index * 1000000000LL / VIDEO_FPS;
            return *out_size > 0;
        }
        nal_start = next;
        code_len = next_len;
    }

    reader->pos = reader->size;
    return 0;
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

    char diagnostic[512];
    size_t preview = reader->size < 16 ? reader->size : 16;
    char hex[16 * 3 + 1] = {0};
    for (size_t i = 0; i < preview; ++i) {
        snprintf(hex + i * 3, sizeof(hex) - i * 3, "%02X ", reader->data[i]);
    }
    snprintf(diagnostic, sizeof(diagnostic),
             "Loaded sample.h264: path=%s size=%lu bytes first_bytes=%s",
             path, (unsigned long)reader->size, hex);
    log_line(diagnostic);
    return 1;
}

static int feed_video(const uint8_t *data, size_t size, int64_t pts_ns,
                      int *last_rc, int *attempts) {
    *last_rc = 0;
    *attempts = 0;
    for (int attempt = 0; attempt < MAX_FEED_RETRIES; ++attempt) {
        int rc = NDL_DirectVideoPlay((void *)data, (unsigned int)size,
                                     (long long)(pts_ns / 1000));
        *last_rc = rc;
        *attempts = attempt + 1;
        if (rc == 0) return 1;
        /* Keep the last native result; the caller records it if retries expire. */
        sleep_ns(FEED_BACKOFF_NS);
    }
    return 0;
}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;

    const char *home = getenv("HOME");
    char old_log_path[512];
    snprintf(old_log_path, sizeof(old_log_path), "%s/drive-tv-native-media-probe.log", home ? home : "/tmp");
    unlink(old_log_path);
    log_line("=== NEW NDL MEDIA PROBE RUN ===");

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

    int ndl_init_rc = -1; /* NDL is initialized only after the SDL window is ready. */

    /* Match the hardware-verified webosbrew sample sequence:
     * SDL preinit -> fullscreen SDL window -> transparent present -> NDL init.
     * The video decoder owns a plane behind this SDL surface. */
    if (SDL_InitSubSystem(SDL_INIT_VIDEO) != 0) {
        log_line(SDL_GetError());
        SDL_Quit();
        munmap(mapping, reader.size);
        return 6;
    }

    SDL_DisplayMode mode;
    if (SDL_GetCurrentDisplayMode(0, &mode) != 0) {
        log_line("SDL_GetCurrentDisplayMode failed");
        if (ndl_init_rc == 0) NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 7;
    }

    SDL_Window *window = SDL_CreateWindow("Drive TV Hardware Decoder Test",
        SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
        mode.w, mode.h, SDL_WINDOW_FULLSCREEN);
    if (!window) {
        log_line(SDL_GetError());
        if (ndl_init_rc == 0) NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 8;
    }
    SDL_Renderer *renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
    if (!renderer) {
        log_line(SDL_GetError());
        SDL_DestroyWindow(window);
        if (ndl_init_rc == 0) NDL_DirectMediaQuit();
        SDL_Quit();
        munmap(mapping, reader.size);
        return 9;
    }
    SDL_SetRenderDrawBlendMode(renderer, SDL_BLENDMODE_NONE);
    render_stage(renderer, mode.w, mode.h, "SDL READY", "WINDOW CREATED", 20);
    log_line("STAGE 2: SDL window and renderer created");
    SDL_SetRenderDrawColor(renderer, 0, 0, 0, 0);
    SDL_RenderClear(renderer);
    SDL_RenderPresent(renderer);

    const char *app_id = getenv("APPID");
    if (!app_id) app_id = "com.syntropy.drivemediaprobe";
    log_line("STAGE 3: SDL window ready; initializing NDL DirectMedia");
    ndl_init_rc = NDL_DirectMediaInit(app_id, resource_released);
    if (ndl_init_rc != 0) {
        char line[512];
        snprintf(line, sizeof(line), "NDL_DirectMediaInit failed: %s", NDL_DirectMediaGetError());
        log_line(line);
    } else {
        NDL_DirectMediaSetAppState(NDL_DIRECTMEDIA_APP_STATE_FOREGROUND);
        log_line("NDL DirectMedia initialized");
    }

    if (ndl_init_rc != 0) {
        show_failure(renderer, mode.w, mode.h, "NDL INIT FAILED");
        SDL_DestroyRenderer(renderer);
        SDL_DestroyWindow(window);
        SDL_Quit();
        munmap(mapping, reader.size);
        return 5;
    }
    
    render_stage(renderer, mode.w, mode.h, "NDL READY", "INITIALIZING MEDIA PIPELINE", 40);
    log_line("STAGE 4: preparing NDL media load");
    NDL_DIRECTMEDIA_DATA_INFO_T info = {
        .video = {
            .width = VIDEO_WIDTH,
            .height = VIDEO_HEIGHT,
            .type = NDL_VIDEO_TYPE_H264
        },
        /* DirectMedia v2 expects the PCM audio descriptor to be initialized
         * even for a video-only stream. Keep type=0 to disable audio, but
         * provide the remaining fields exactly as the upstream sample does. */
        .audio = {
            .pcm = {
                .type = 0,
                .format = NDL_DIRECTMEDIA_AUDIO_PCM_FORMAT_S16LE,
                .layout = "interleaved",
                .channelMode = "stereo",
                /* No audio stream: the upstream sample passes zero channels/rate. */
                .sampleRate = NDL_DIRECTMEDIA_AUDIO_PCM_SAMPLE_RATE_NONE
            }
        }
    };
    if (NDL_DirectMediaLoad(&info, media_callback) != 0) {
        char line[512];
        const char *ndl_error = NDL_DirectMediaGetError();
        snprintf(line, sizeof(line), "NDL_DirectMediaLoad failed: %s", ndl_error ? ndl_error : "(no error text)");
        log_line(line);
        show_failure_detail(renderer, mode.w, mode.h, ndl_error);
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
    /* The video is rendered on a hardware plane BEHIND the SDL window.
     * The upstream sample clears the SDL surface to transparent once and then
     * leaves it alone. Any opaque status screen here would hide the video. */
    SDL_SetRenderDrawColor(renderer, 0, 0, 0, 0);
    SDL_RenderClear(renderer);
    SDL_RenderPresent(renderer);
    log_line("STAGE 5: NDL LOAD accepted - feeding immediately; LOADCOMPLETED is informational");

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

        int feed_rc = 0;
        int feed_attempts = 0;
        if (!feed_video(unit, unit_size, pts, &feed_rc, &feed_attempts)) {
            char line[512];
            const char *ndl_error = NDL_DirectMediaGetError();
            snprintf(line, sizeof(line),
                     "ERROR: NDL_DirectVideoPlay failed frame=%ld size=%lu pts_us=%lld rc=%d attempts=%d error=%s",
                     frames, (unsigned long)unit_size, (long long)(pts / 1000),
                     feed_rc, feed_attempts, ndl_error ? ndl_error : "(none)");
            log_line(line);
            log_line(g_load_completed ? "LOADCOMPLETED had been received before feed failure" :
                                       "LOADCOMPLETED had NOT been received before feed failure");
            failed = 1;
            break;
        }
        frames++;
    }

    if (frames > 0 && !failed) {
        char line[256];
        snprintf(line, sizeof(line), "NDL VIDEO FEED OK - %ld H.264 frames submitted", frames);
        log_line(line);
        log_line(g_load_completed ? "NDL LOADCOMPLETED observed during feed" :
                                   "NDL LOADCOMPLETED not observed during feed");
        log_line(g_playing ? "NDL PLAYING event observed during feed" :
                             "NDL PLAYING event NOT observed during feed");
    } else if (!failed) {
        log_line("No H.264 access units were parsed from sample.h264");
        failed = 1;
    }

    if (failed == 1) {
        log_line("STAGE ERROR: video access-unit submission failed");
        char report_id[16] = {0};
        int uploaded = upload_diagnostic_log(report_id, sizeof(report_id));
        log_line(uploaded ? "Diagnostic report uploaded to Worker" :
                            "Diagnostic report upload failed");
        show_failure_report(renderer, mode.w, mode.h, uploaded ? report_id : "");
    }

    /* Let the decoder drain while the SDL surface remains transparent.
     * The five-second sample is paced in real time; allow another two seconds
     * for the last decoded frames before unloading the hardware plane. */
    log_line("Waiting up to 2 seconds for decoder drain; SDL surface remains transparent");
    int64_t hold_until = monotonic_ns() + 2000000000LL;
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

    if (failed == 0) {
        char summary[256];
        snprintf(summary, sizeof(summary), "Final events: LOADCOMPLETED=%s PLAYING=%s frames=%ld",
                 g_load_completed ? "yes" : "no", g_playing ? "yes" : "no", frames);
        log_line(summary);
        char report_id[16] = {0};
        int uploaded = upload_diagnostic_log(report_id, sizeof(report_id));
        log_line(uploaded ? "Successful-run diagnostic uploaded" : "Successful-run diagnostic upload failed");
        NDL_DirectMediaUnload();
        NDL_DirectMediaQuit();
        SDL_SetRenderDrawColor(renderer, 8, 12, 22, 255);
        SDL_RenderClear(renderer);
        SDL_Color white = {245, 248, 255, 255};
        SDL_Color cyan = {110, 205, 255, 255};
        int scale = mode.w / 180;
        if (scale < 3) scale = 3;
        if (scale > 8) scale = 8;
        draw_text(renderer, "MEDIA TEST FINISHED", mode.w / 2, mode.h / 3, scale, white);
        draw_text(renderer, g_playing ? "PLAYING EVENT RECEIVED" : "NO PLAYING EVENT",
                  mode.w / 2, mode.h / 2 - 25, scale, cyan);
        if (uploaded) {
            draw_text(renderer, "REPORT CODE", mode.w / 2, mode.h / 2 + 55, scale, white);
            draw_text(renderer, report_id, mode.w / 2, mode.h / 2 + 105, scale + 2, cyan);
            draw_text(renderer, "SEND CODE IN CHAT", mode.w / 2, mode.h / 2 + 165, scale, white);
        } else {
            draw_text(renderer, "REPORT UPLOAD FAILED", mode.w / 2, mode.h / 2 + 75, scale, cyan);
        }
        SDL_RenderPresent(renderer);
        int64_t result_until = monotonic_ns() + 60000000000LL;
        while (monotonic_ns() < result_until) {
            SDL_Event event;
            while (SDL_PollEvent(&event)) {
                if (event.type == SDL_QUIT || (event.type == SDL_KEYDOWN &&
                    (event.key.keysym.sym == SDLK_ESCAPE || event.key.keysym.sym == SDLK_BACKSPACE ||
                     event.key.keysym.sym == SDLK_q))) result_until = 0;
            }
            SDL_Delay(30);
        }
    } else {
        NDL_DirectMediaUnload();
        NDL_DirectMediaQuit();
    }
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    munmap(mapping, reader.size);
    return failed == 1 ? 11 : 0;
}
