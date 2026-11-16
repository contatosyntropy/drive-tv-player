#define NDL_DIRECTMEDIA_API_VERSION 2
#include <SDL.h>
#include <curl/curl.h>
#include <NDL_directmedia.h>
#include <libavformat/avformat.h>
#include <libavcodec/bsf.h>
#include <libavutil/avutil.h>
#include <libavutil/error.h>
#include <libavutil/mathematics.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define RANGE_CHUNK (1024 * 1024)
#define AVIO_BUFFER (64 * 1024)
#define MAX_FEED_RETRIES 200
#define FEED_BACKOFF_NS 5000000LL
#define LOG_PATH_SUFFIX "/drive-tv-native-stream-player.log"

static volatile int g_load_completed = 0;
static volatile int g_playing = 0;

static void log_line(const char *s) {
    const char *home = getenv("HOME");
    char path[512];
    snprintf(path, sizeof(path), "%s%s", home ? home : "/tmp", LOG_PATH_SUFFIX);
    FILE *f = fopen(path, "a");
    if (f) { fprintf(f, "%s\n", s); fclose(f); }
    fprintf(stderr, "%s\n", s);
}

typedef struct { char body[512]; size_t used; } Response;
static size_t response_write(char *p, size_t a, size_t b, void *opaque) {
    Response *r = opaque; size_t n = a*b;
    if (n > sizeof(r->body)-r->used-1) n = sizeof(r->body)-r->used-1;
    memcpy(r->body+r->used,p,n); r->used+=n; r->body[r->used]=0; return a*b;
}
static int upload_log(char *id, size_t cap) {
    const char *home=getenv("HOME"); char path[512];
    snprintf(path,sizeof(path),"%s%s",home?home:"/tmp",LOG_PATH_SUFFIX);
    FILE *f=fopen(path,"rb"); if(!f)return 0;
    char body[24001]; size_t n=fread(body,1,sizeof(body)-1,f); fclose(f);
    if(!n || n>=sizeof(body)-1)return 0; body[n]=0;
    CURL *c=curl_easy_init(); if(!c)return 0;
    Response r={{0},0}; struct curl_slist *h=NULL;
    h=curl_slist_append(h,"Content-Type: text/plain; charset=utf-8");
    curl_easy_setopt(c,CURLOPT_URL,"https://drive-tv-player.contatosyntropy.workers.dev/api/probe-log");
    curl_easy_setopt(c,CURLOPT_HTTPHEADER,h); curl_easy_setopt(c,CURLOPT_POST,1L);
    curl_easy_setopt(c,CURLOPT_POSTFIELDS,body); curl_easy_setopt(c,CURLOPT_POSTFIELDSIZE_LARGE,(curl_off_t)n);
    curl_easy_setopt(c,CURLOPT_WRITEFUNCTION,response_write); curl_easy_setopt(c,CURLOPT_WRITEDATA,&r);
    curl_easy_setopt(c,CURLOPT_CONNECTTIMEOUT,15L); curl_easy_setopt(c,CURLOPT_TIMEOUT,30L);
    curl_easy_setopt(c,CURLOPT_NOSIGNAL,1L); curl_easy_setopt(c,CURLOPT_SSL_VERIFYPEER,1L);
    curl_easy_setopt(c,CURLOPT_SSL_VERIFYHOST,2L);
    CURLcode rc=curl_easy_perform(c); long status=0; curl_easy_getinfo(c,CURLINFO_RESPONSE_CODE,&status);
    int ok=0; char *p=strstr(r.body,"\"id\":\"");
    if(rc==CURLE_OK && status==201 && p && cap>=9 && strlen(p+6)>=8){memcpy(id,p+6,8);id[8]=0;ok=1;}
    curl_slist_free_all(h); curl_easy_cleanup(c); return ok;
}

typedef struct {
    CURL *curl;
    char *url;
    uint8_t *cache;
    size_t cache_len;
    int64_t cache_start;
    int64_t file_size;
    int64_t position;
    char content_range[160];
    char error[256];
} RangeReader;

typedef struct { uint8_t *data; size_t cap; size_t used; } RangeBuffer;
static size_t range_write(char *p,size_t a,size_t b,void *opaque){
    RangeBuffer *o=opaque; size_t n=a*b;
    if(n>o->cap-o->used)return 0;
    memcpy(o->data+o->used,p,n);o->used+=n;return n;
}
static size_t range_header(char *p,size_t a,size_t b,void *opaque){
    RangeReader *r=opaque;size_t n=a*b;
    if(n>14 && !strncasecmp(p,"Content-Range:",14)){
        size_t k=n-14;if(k>=sizeof(r->content_range))k=sizeof(r->content_range)-1;
        memcpy(r->content_range,p+14,k);r->content_range[k]=0;
    }return n;
}
static int fetch_range(RangeReader *r,int64_t start){
    int64_t end=start+RANGE_CHUNK-1;
    if(r->file_size>0 && end>=r->file_size)end=r->file_size-1;
    if(end<start)return AVERROR_EOF;
    char range[128];snprintf(range,sizeof(range),"Range: bytes=%lld-%lld",(long long)start,(long long)end);
    struct curl_slist *headers=NULL;headers=curl_slist_append(headers,range);
    RangeBuffer out={r->cache,RANGE_CHUNK,0};r->content_range[0]=0;
    curl_easy_reset(r->curl);
    curl_easy_setopt(r->curl,CURLOPT_URL,r->url);
    curl_easy_setopt(r->curl,CURLOPT_HTTPHEADER,headers);
    curl_easy_setopt(r->curl,CURLOPT_FOLLOWLOCATION,1L);
    curl_easy_setopt(r->curl,CURLOPT_ACCEPT_ENCODING,"identity");
    curl_easy_setopt(r->curl,CURLOPT_WRITEFUNCTION,range_write);
    curl_easy_setopt(r->curl,CURLOPT_WRITEDATA,&out);
    curl_easy_setopt(r->curl,CURLOPT_HEADERFUNCTION,range_header);
    curl_easy_setopt(r->curl,CURLOPT_HEADERDATA,r);
    curl_easy_setopt(r->curl,CURLOPT_CONNECTTIMEOUT,20L);
    curl_easy_setopt(r->curl,CURLOPT_TIMEOUT,90L);
    curl_easy_setopt(r->curl,CURLOPT_NOSIGNAL,1L);
    curl_easy_setopt(r->curl,CURLOPT_SSL_VERIFYPEER,1L);
    curl_easy_setopt(r->curl,CURLOPT_SSL_VERIFYHOST,2L);
    curl_easy_setopt(r->curl,CURLOPT_USERAGENT,"DriveTVNativeStream/0.1");
    CURLcode code=curl_easy_perform(r->curl);long status=0;
    curl_easy_getinfo(r->curl,CURLINFO_RESPONSE_CODE,&status);
    curl_slist_free_all(headers);
    if(code!=CURLE_OK || status!=206 || out.used==0){
        snprintf(r->error,sizeof(r->error),"HTTP Range failed: curl=%d HTTP=%ld bytes=%lu",code,status,(unsigned long)out.used);
        log_line(r->error);return AVERROR(EIO);
    }
    char *slash=strrchr(r->content_range,'/');
    if(slash && slash[1]!='*'){int64_t total=atoll(slash+1);if(total>0)r->file_size=total;}
    r->cache_start=start;r->cache_len=out.used;
    char line[256];snprintf(line,sizeof(line),"HTTP Range OK: bytes=%lld-%lld received=%lu total=%lld",
      (long long)start,(long long)(start+(int64_t)out.used-1),(unsigned long)out.used,(long long)r->file_size);
    log_line(line);return 0;
}
static int avio_read_packet(void *opaque,uint8_t *buf,int buf_size){
    RangeReader *r=opaque;if(buf_size<=0)return 0;
    if(r->file_size>0 && r->position>=r->file_size)return AVERROR_EOF;
    if(r->position<r->cache_start || r->position>=r->cache_start+(int64_t)r->cache_len){
        int rc=fetch_range(r,r->position);if(rc<0)return rc;
    }
    size_t offset=(size_t)(r->position-r->cache_start);
    size_t n=r->cache_len-offset;if(n>(size_t)buf_size)n=(size_t)buf_size;
    if(r->file_size>0 && (int64_t)n>r->file_size-r->position)n=(size_t)(r->file_size-r->position);
    memcpy(buf,r->cache+offset,n);r->position+=(int64_t)n;return (int)n;
}
static int64_t avio_seek(void *opaque,int64_t offset,int whence){
    RangeReader *r=opaque;
    if(whence==AVSEEK_SIZE)return r->file_size>0?r->file_size:AVERROR(ENOSYS);
    whence &= ~AVSEEK_FORCE;
    int64_t next;
    if(whence==SEEK_SET)next=offset;
    else if(whence==SEEK_CUR)next=r->position+offset;
    else if(whence==SEEK_END && r->file_size>0)next=r->file_size+offset;
    else return AVERROR(EINVAL);
    if(next<0)return AVERROR(EINVAL);r->position=next;return next;
}
static void media_callback(int type,long long number,const char *value){
    char line[256];snprintf(line,sizeof(line),"NDL event type=%d value=%lld %s",type,number,value?value:"");
    log_line(line);if(type==0x16)g_load_completed=1;if(type==0x1a)g_playing=1;
}
static void resource_released(const char *type){char s[200];snprintf(s,sizeof(s),"NDL resource released: %s",type?type:"?");log_line(s);}
static int64_t monotonic_ns(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (int64_t)t.tv_sec*1000000000LL+t.tv_nsec;}
static void sleep_ns(int64_t ns){if(ns<=0)return;struct timespec t={(time_t)(ns/1000000000LL),(long)(ns%1000000000LL)};while(nanosleep(&t,&t)&&errno==EINTR){}}
static void wait_until(int64_t target){int64_t now=monotonic_ns();if(target>now)sleep_ns(target-now);}
static int feed_frame(AVPacket *p,AVRational tb,int64_t origin_us,int64_t *clock_origin,int *last_rc){
    int64_t pts=p->pts==AV_NOPTS_VALUE?0:av_rescale_q(p->pts,tb,AV_TIME_BASE_Q)-origin_us;
    int64_t dts=p->dts==AV_NOPTS_VALUE?pts:av_rescale_q(p->dts,tb,AV_TIME_BASE_Q)-origin_us;
    if(pts<0)pts=0;if(dts<0)dts=0;
    if(*clock_origin==0)*clock_origin=monotonic_ns()-dts*1000LL;
    wait_until(*clock_origin+dts*1000LL);
    for(int i=0;i<MAX_FEED_RETRIES;i++){
        int rc=NDL_DirectVideoPlay(p->data,(unsigned int)p->size,(long long)pts);
        *last_rc=rc;if(rc==0)return 1;sleep_ns(FEED_BACKOFF_NS);
    }return 0;
}
static int drain_bsf(AVBSFContext *bsf,AVRational tb,int64_t origin_us,int64_t *clock_origin,long *frames){
    AVPacket *out=av_packet_alloc();if(!out)return AVERROR(ENOMEM);
    int last=0,result=0;
    while((result=av_bsf_receive_packet(bsf,out))>=0){
        if(!feed_frame(out,tb,origin_us,clock_origin,&last)){
            char s[300];const char *e=NDL_DirectMediaGetError();
            snprintf(s,sizeof(s),"NDL_DirectVideoPlay failed frame=%ld size=%d rc=%d error=%s",
              *frames,out->size,last,e?e:"(none)");log_line(s);av_packet_free(&out);return AVERROR(EIO);
        }
        (*frames)++;av_packet_unref(out);
    }
    av_packet_free(&out);return result==AVERROR(EAGAIN)||result==AVERROR_EOF?0:result;
}
static int read_stream_url(char *url,size_t cap){
    char exe[512];ssize_t n=readlink("/proc/self/exe",exe,sizeof(exe)-1);if(n<=0)return 0;
    exe[n]=0;char *slash=strrchr(exe,'/');if(!slash)return 0;strcpy(slash+1,"stream-url.txt");
    FILE *f=fopen(exe,"rb");if(!f)return 0;
    size_t got=fread(url,1,cap-1,f);fclose(f);while(got && (url[got-1]=='\n'||url[got-1]=='\r'||url[got-1]==' '))got--;
    url[got]=0;return got>0;
}
int main(void){
    const char *home=getenv("HOME");char logpath[512];snprintf(logpath,sizeof(logpath),"%s%s",home?home:"/tmp",LOG_PATH_SUFFIX);unlink(logpath);
    log_line("=== DIRECT GOOGLE DRIVE MKV STREAM START ===");
    char url[4096];if(!read_stream_url(url,sizeof(url))){log_line("stream-url.txt missing or invalid");return 2;}
    if(!strstr(url,"/api/video/")||!strstr(url,"?key=")){log_line("stream URL must be a Worker /api/video URL with key");return 2;}
    RangeReader rr={0};rr.url=url;rr.cache=malloc(RANGE_CHUNK);rr.file_size=-1;rr.cache_start=-1;rr.curl=curl_easy_init();
    if(!rr.cache||!rr.curl){log_line("Cannot initialize HTTP Range reader");return 3;}
    if(curl_global_init(CURL_GLOBAL_DEFAULT)!=CURLE_OK){log_line("curl global init failed");return 3;}
    AVFormatContext *fmt=avformat_alloc_context();uint8_t *avio_buf=av_malloc(AVIO_BUFFER);
    AVIOContext *avio=avio_alloc_context(avio_buf,AVIO_BUFFER,0,&rr,avio_read_packet,NULL,avio_seek);
    if(!fmt||!avio){log_line("Cannot allocate FFmpeg custom AVIO");return 4;}
    fmt->pb=avio;fmt->flags|=AVFMT_FLAG_CUSTOM_IO;
    log_line("Opening Matroska over HTTP Range...");
    int rc=avformat_open_input(&fmt,NULL,NULL,NULL);
    if(rc<0){char e[256];av_strerror(rc,e,sizeof(e));log_line(e);snprintf(rr.error,sizeof(rr.error),"Matroska open failed: %s",e);goto fail_early;}
    rc=avformat_find_stream_info(fmt,NULL);
    if(rc<0){char e[256];av_strerror(rc,e,sizeof(e));log_line(e);goto fail_early;}
    int video=av_find_best_stream(fmt,AVMEDIA_TYPE_VIDEO,-1,-1,NULL,0);
    if(video<0){log_line("No video stream found in MKV");goto fail_early;}
    AVStream *st=fmt->streams[video];
    if(st->codecpar->codec_id!=AV_CODEC_ID_HEVC){log_line("Selected video stream is not HEVC");goto fail_early;}
    char meta[256];snprintf(meta,sizeof(meta),"MKV opened: %dx%d profile=%d time_base=%d/%d duration=%lld",
      st->codecpar->width,st->codecpar->height,st->codecpar->profile,st->time_base.num,st->time_base.den,
      (long long)fmt->duration);log_line(meta);
    const AVBitStreamFilter *filter=av_bsf_get_by_name("hevc_mp4toannexb");AVBSFContext *bsf=NULL;
    if(!filter||av_bsf_alloc(filter,&bsf)<0){log_line("Cannot allocate HEVC Annex-B bitstream filter");goto fail_early;}
    if(avcodec_parameters_copy(bsf->par_in,st->codecpar)<0||av_bsf_init(bsf)<0){log_line("Cannot initialize HEVC Annex-B filter");av_bsf_free(&bsf);goto fail_early;}

    setenv("EGL_PLATFORM","wayland",0);setenv("XDG_RUNTIME_DIR","/tmp/xdg",0);
    if(SDL_Init(0)!=0||SDL_InitSubSystem(SDL_INIT_VIDEO)!=0){log_line(SDL_GetError());av_bsf_free(&bsf);goto fail_early;}
    SDL_DisplayMode mode;if(SDL_GetCurrentDisplayMode(0,&mode)!=0){log_line(SDL_GetError());SDL_Quit();av_bsf_free(&bsf);goto fail_early;}
    SDL_Window *window=SDL_CreateWindow("Drive TV Stream Player",SDL_WINDOWPOS_UNDEFINED,SDL_WINDOWPOS_UNDEFINED,mode.w,mode.h,SDL_WINDOW_FULLSCREEN);
    SDL_Renderer *renderer=window?SDL_CreateRenderer(window,-1,SDL_RENDERER_ACCELERATED):NULL;
    if(!renderer){log_line(SDL_GetError());if(window)SDL_DestroyWindow(window);SDL_Quit();av_bsf_free(&bsf);goto fail_early;}
    SDL_SetRenderDrawBlendMode(renderer,SDL_BLENDMODE_NONE);SDL_SetRenderDrawColor(renderer,0,0,0,255);SDL_RenderClear(renderer);SDL_RenderPresent(renderer);
    int ndl=NDL_DirectMediaInit("com.syntropy.drivestreamplayer",resource_released);
    if(ndl!=0){const char *e=NDL_DirectMediaGetError();log_line(e?e:"NDL init failed");goto fail_ui;}
    NDL_DirectMediaSetAppState(NDL_DIRECTMEDIA_APP_STATE_FOREGROUND);
    NDL_DIRECTMEDIA_DATA_INFO_T info={0};
    info.video.width=st->codecpar->width;info.video.height=st->codecpar->height;info.video.type=NDL_VIDEO_TYPE_H265;
    info.audio.pcm.type=0;info.audio.pcm.format=NDL_DIRECTMEDIA_AUDIO_PCM_FORMAT_S16LE;
    info.audio.pcm.layout="interleaved";info.audio.pcm.channelMode="stereo";
    info.audio.pcm.sampleRate=NDL_DIRECTMEDIA_AUDIO_PCM_SAMPLE_RATE_NONE;
    if(NDL_DirectMediaLoad(&info,media_callback)!=0){const char *e=NDL_DirectMediaGetError();log_line(e?e:"NDL load failed");NDL_DirectMediaQuit();goto fail_ui;}
    if(NDL_DirectVideoSetArea(0,0,mode.w,mode.h)!=0){log_line("NDL_DirectVideoSetArea failed");NDL_DirectMediaUnload();NDL_DirectMediaQuit();goto fail_ui;}
    SDL_SetRenderDrawColor(renderer,0,0,0,0);SDL_RenderClear(renderer);SDL_RenderPresent(renderer);
    log_line("NDL load accepted; beginning continuous HEVC packet feed");
    AVPacket *packet=av_packet_alloc();int64_t origin_us=AV_NOPTS_VALUE,clock_origin=0;long frames=0;int failed=0;
    while((rc=av_read_frame(fmt,packet))>=0){
        if(packet->stream_index==video){
            if(origin_us==AV_NOPTS_VALUE){
                int64_t first=packet->dts!=AV_NOPTS_VALUE?packet->dts:packet->pts;
                origin_us=first==AV_NOPTS_VALUE?0:av_rescale_q(first,st->time_base,AV_TIME_BASE_Q);
            }
            rc=av_bsf_send_packet(bsf,packet);
            if(rc<0){log_line("HEVC bitstream filter rejected packet");failed=1;av_packet_unref(packet);break;}
            rc=drain_bsf(bsf,st->time_base,origin_us,&clock_origin,&frames);
            if(rc<0){failed=1;av_packet_unref(packet);break;}
        }
        av_packet_unref(packet);
        if(SDL_QuitRequested()){failed=2;break;}
    }
    if(!failed){
        av_bsf_send_packet(bsf,NULL);
        if(drain_bsf(bsf,st->time_base,origin_us==AV_NOPTS_VALUE?0:origin_us,&clock_origin,&frames)<0)failed=1;
    }
    av_packet_free(&packet);
    {char s[256];snprintf(s,sizeof(s),"Stream ended: frames=%ld LOADCOMPLETED=%s PLAYING=%s read_rc=%d",
      frames,g_load_completed?"yes":"no",g_playing?"yes":"no",rc);log_line(s);}
    if(!frames)failed=1;
    if(failed==1){char id[16]={0};int up=upload_log(id,sizeof(id));log_line(up?"Failure diagnostic uploaded":"Failure diagnostic upload failed");}
    if(failed==0){
        sleep_ns(1500000000LL);NDL_DirectMediaUnload();NDL_DirectMediaQuit();
        char id[16]={0};int up=upload_log(id,sizeof(id));(void)up;
    }else{NDL_DirectMediaUnload();NDL_DirectMediaQuit();}
    av_bsf_free(&bsf);SDL_DestroyRenderer(renderer);SDL_DestroyWindow(window);SDL_Quit();
    avformat_close_input(&fmt);if(avio)avio_context_free(&avio);curl_easy_cleanup(rr.curl);curl_global_cleanup();free(rr.cache);
    return failed==1?10:0;

fail_ui:
    SDL_DestroyRenderer(renderer);SDL_DestroyWindow(window);SDL_Quit();av_bsf_free(&bsf);
fail_early:
    {char s[300];snprintf(s,sizeof(s),"STREAM FAILED: %s",rr.error[0]?rr.error:"see preceding FFmpeg/NDL diagnostic");log_line(s);
     char id[16]={0};upload_log(id,sizeof(id));}
    if(fmt)avformat_close_input(&fmt);if(avio)avio_context_free(&avio);
    if(rr.curl)curl_easy_cleanup(rr.curl);curl_global_cleanup();free(rr.cache);return 11;
}
