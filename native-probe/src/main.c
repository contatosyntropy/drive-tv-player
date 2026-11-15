#include <SDL.h>
#include <curl/curl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

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

static void write_log(const char *message) {
    const char *home = getenv("HOME");
    char path[512];
    snprintf(path, sizeof(path), "%s/drive-tv-native-probe.log", home ? home : "/tmp");
    FILE *file = fopen(path, "w");
    if (file) {
        fprintf(file, "%s\n", message);
        fclose(file);
    }
    fprintf(stderr, "%s\n", message);
}

typedef struct {
    size_t bytes;
    char content_range[128];
} HttpProbe;

static size_t receive_body(char *data, size_t size, size_t count, void *opaque) {
    (void)data;
    HttpProbe *probe = (HttpProbe *)opaque;
    size_t bytes = size * count;
    probe->bytes += bytes;
    return bytes;
}

static size_t receive_header(char *data, size_t size, size_t count, void *opaque) {
    HttpProbe *probe = (HttpProbe *)opaque;
    size_t bytes = size * count;
    if (bytes > 14 && !strncasecmp(data, "Content-Range:", 14)) {
        size_t start = 14;
        while (start < bytes && (data[start] == ' ' || data[start] == '\\t')) start++;
        size_t length = bytes - start;
        while (length && (data[start + length - 1] == '\\r' || data[start + length - 1] == '\\n')) length--;
        if (length >= sizeof(probe->content_range)) length = sizeof(probe->content_range) - 1;
        memcpy(probe->content_range, data + start, length);
        probe->content_range[length] = 0;
    }
    return bytes;
}

static int verify_https_range(char *result, size_t result_size) {
    CURL *curl;
    CURLcode code;
    long status = 0;
    HttpProbe probe = {0, ""};
    curl_global_init(CURL_GLOBAL_DEFAULT);
    curl = curl_easy_init();
    if (!curl) {
        snprintf(result, result_size, "libcurl initialization failed");
        curl_global_cleanup();
        return 0;
    }
    curl_easy_setopt(curl, CURLOPT_URL, "https://drive-tv-player.contatosyntropy.workers.dev/api/reference-mkv");
    curl_easy_setopt(curl, CURLOPT_RANGE, "0-4095");
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 20L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 45L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "DriveTVNativeProbe/0.2");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive_body);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &probe);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, receive_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &probe);
    code = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    if (code == CURLE_OK && status == 206 && probe.bytes > 0 &&
        !strncasecmp(probe.content_range, "bytes 0-", 8)) {
        snprintf(result, result_size, "HTTPS RANGE OK");
        write_log("HTTPS RANGE OK - resposta 206 recebida do Worker por TLS.");
    } else {
        snprintf(result, result_size, "HTTPS RANGE FAILED");
        char detail[512];
        snprintf(detail, sizeof(detail), "HTTPS RANGE FAILED - curl=%s; HTTP=%ld; bytes=%lu; range=%s",
                 curl_easy_strerror(code), status, (unsigned long)probe.bytes,
                 probe.content_range[0] ? probe.content_range : "(missing)");
        write_log(detail);
    }
    curl_easy_cleanup(curl);
    curl_global_cleanup();
    return code == CURLE_OK && status == 206 && probe.bytes > 0;
}

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

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;

    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        char error[512];
        snprintf(error, sizeof(error), "SDL_Init falhou: %s", SDL_GetError());
        write_log(error);
        return 2;
    }

    SDL_DisplayMode mode;
    int width = 1920;
    int height = 1080;
    if (SDL_GetCurrentDisplayMode(0, &mode) == 0 && mode.w > 0 && mode.h > 0) {
        width = mode.w;
        height = mode.h;
    }

    SDL_Window *window = SDL_CreateWindow(
        "Drive TV Native Probe",
        SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
        width, height,
        SDL_WINDOW_FULLSCREEN | SDL_WINDOW_ALLOW_HIGHDPI
    );
    if (!window) {
        char error[512];
        snprintf(error, sizeof(error), "SDL_CreateWindow falhou: %s", SDL_GetError());
        write_log(error);
        SDL_Quit();
        return 3;
    }

    SDL_Renderer *renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
    if (!renderer) renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
    if (!renderer) {
        char error[512];
        snprintf(error, sizeof(error), "SDL_CreateRenderer falhou: %s", SDL_GetError());
        write_log(error);
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 4;
    }

    write_log("NATIVE APP OK - executavel ARM iniciado e janela SDL criada.");
    char network_status[64] = "CHECKING HTTPS";
    int network_ok = verify_https_range(network_status, sizeof(network_status));
    int scale = width / 150;
    if (scale < 5) scale = 5;
    if (scale > 16) scale = 16;

    SDL_SetRenderDrawColor(renderer, 8, 9, 18, 255);
    SDL_RenderClear(renderer);

    SDL_Rect accent = {width / 4, height / 2 - 170 * scale / 8, width / 2, 8};
    SDL_SetRenderDrawColor(renderer, 139, 92, 246, 255);
    SDL_RenderFillRect(renderer, &accent);

    SDL_Color white = {245, 245, 250, 255};
    SDL_Color purple = {190, 160, 255, 255};
    SDL_Color muted = {165, 170, 190, 255};
    draw_text(renderer, "DRIVE TV PLAYER", width / 2, height / 2 - 90 * scale / 8, scale, white);
    draw_text(renderer, "NATIVE APP OK", width / 2, height / 2 - 10 * scale / 8, scale, purple);
    draw_text(renderer, network_ok ? "HTTPS RANGE OK" : "HTTPS RANGE FAILED", width / 2, height / 2 + 70 * scale / 8, scale, network_ok ? purple : white);
    draw_text(renderer, "BACK TO EXIT", width / 2, height / 2 + 170 * scale / 8, scale, muted);
    SDL_RenderPresent(renderer);

    int running = 1;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT ||
                (event.type == SDL_KEYDOWN &&
                 (event.key.keysym.sym == SDLK_ESCAPE ||
                  event.key.keysym.sym == SDLK_BACKSPACE ||
                  event.key.keysym.sym == SDLK_q))) {
                running = 0;
            }
        }
        SDL_Delay(16);
    }

    write_log("Native probe encerrado normalmente.");
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
