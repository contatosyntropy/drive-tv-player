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
#include <strings.h>
#include <time.h>
#include <unistd.h>
#include <pthread.h>

#define RANGE_CHUNK (8 * 1024 * 1024)
#define AVIO_BUFFER (256 * 1024)
#define MAX_FEED_RETRIES 200
#define FEED_BACKOFF_NS 5000000LL
#define LOG_PATH_SUFFIX "/drive-tv-native-stream-player.log"

static volatile int g_load_completed = 0;
static volatile int g_playing = 0;
static int64_t g_feed_window_start = 0;
static int64_t g_feed_call_total_ns = 0;
static int64_t g_feed_call_max_ns = 0;
static long g_feed_calls = 0;
static long g_feed_retries = 0;

/* Main-thread diagnostics: AVIO latency and frame-timestamp pacing. */
static int64_t g_avio_read_total_ns = 0;
static int64_t g_avio_read_max_ns = 0;
static long g_avio_read_calls = 0;
static long g_avio_read_bytes = 0;
static int64_t g_diag_last_dts_us = AV_NOPTS_VALUE;
static int64_t g_diag_dts_delta_sum_us = 0;
static int64_t g_diag_dts_delta_min_us = INT64_MAX;
static int64_t g_diag_dts_delta_max_us = 0;
static int64_t g_diag_pts_offset_sum_us = 0;
static int64_t g_diag_pts_offset_min_us = INT64_MAX;
static int64_t g_diag_pts_offset_max_us = INT64_MIN;
static int64_t g_diag_wait_total_ns = 0;
static int64_t g_diag_wait_max_ns = 0;
static int64_t g_diag_late_total_ns = 0;
static int64_t g_diag_late_max_ns = 0;
static int64_t g_diag_duration_sum_us = 0;
static long g_diag_timed_frames = 0;
static long g_diag_packet_samples = 0;

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
    CURL *worker_curl;
    char *url;
    uint8_t *cache;
    uint8_t *next_cache;
    size_t cache_len;
    size_t next_len;
    int64_t cache_start;
    int64_t next_start;
    int64_t file_size;
    int64_t position;
    pthread_t worker;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    int sync_ready;
    int worker_started;
    int worker_stop;
    int worker_pending;
    int worker_busy;
    int next_ready;
    int64_t request_start;
    unsigned long generation;
    unsigned long request_generation;
    char error[256];
} RangeReader;

typedef struct { uint8_t *data; size_t cap; size_t used; } RangeBuffer;
static size_t range_write(char *p,size_t a,size_t b,void *opaque){
    RangeBuffer *o=opaque; size_t n=a*b;
    if(n>o->cap-o->used)return 0;
    memcpy(o->data+o->used,p,n);o->used+=n;return n;
}
typedef struct { char value[160]; } RangeHeader;
static size_t range_header(char *p,size_t a,size_t b,void *opaque){
    RangeHeader *h=opaque;size_t n=a*b;
    if(n>14 && !strncasecmp(p,"Content-Range:",14)){
        size_t k=n-14;if(k>=sizeof(h->value))k=sizeof(h->value)-1;
        memcpy(h->value,p+14,k);h->value[k]=0;
    }return n;
}
static int fetch_range_data(RangeReader *r,CURL *curl,uint8_t *dest,
                            int64_t start,size_t *received,int64_t *known_size){
    int64_t end=start+RANGE_CHUNK-1;
    if(*known_size>0 && end>=*known_size)end=*known_size-1;
    if(end<start)return AVERROR_EOF;
    char range[128];snprintf(range,sizeof(range),"Range: bytes=%lld-%lld",(long long)start,(long long)end);
    struct curl_slist *headers=NULL;headers=curl_slist_append(headers,range);
    RangeBuffer out={dest,RANGE_CHUNK,0};RangeHeader rh={{0}};
    curl_easy_reset(curl);
    curl_easy_setopt(curl,CURLOPT_URL,r->url);
    curl_easy_setopt(curl,CURLOPT_HTTPHEADER,headers);
    curl_easy_setopt(curl,CURLOPT_FOLLOWLOCATION,1L);
    curl_easy_setopt(curl,CURLOPT_ACCEPT_ENCODING,"identity");
    curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,range_write);
    curl_easy_setopt(curl,CURLOPT_WRITEDATA,&out);
    curl_easy_setopt(curl,CURLOPT_HEADERFUNCTION,range_header);
    curl_easy_setopt(curl,CURLOPT_HEADERDATA,&rh);
    curl_easy_setopt(curl,CURLOPT_CONNECTTIMEOUT,20L);
    curl_easy_setopt(curl,CURLOPT_TIMEOUT,90L);
    curl_easy_setopt(curl,CURLOPT_NOSIGNAL,1L);
    curl_easy_setopt(curl,CURLOPT_SSL_VERIFYPEER,1L);
    curl_easy_setopt(curl,CURLOPT_SSL_VERIFYHOST,2L);
    curl_easy_setopt(curl,CURLOPT_USERAGENT,"DriveTVNativeStream/0.2");
    curl_easy_setopt(curl,CURLOPT_TCP_KEEPALIVE,1L);
    struct timespec t0,t1;clock_gettime(CLOCK_MONOTONIC,&t0);
    CURLcode code=curl_easy_perform(curl);long status=0;
    curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status);
    clock_gettime(CLOCK_MONOTONIC,&t1);
    double elapsed=(double)(t1.tv_sec-t0.tv_sec)+(double)(t1.tv_nsec-t0.tv_nsec)/1000000000.0;
    curl_slist_free_all(headers);
    if(code!=CURLE_OK || status!=206 || out.used==0){
        snprintf(r->error,sizeof(r->error),"HTTP Range failed: curl=%d HTTP=%ld bytes=%lu",code,status,(unsigned long)out.used);
        log_line(r->error);return AVERROR(EIO);
    }
    char *slash=strrchr(rh.value,'/');
    if(slash && slash[1]!='*'){int64_t total=atoll(slash+1);if(total>0)*known_size=total;}
    *received=out.used;
    char line[320];double mbps=elapsed>0.0?((double)out.used*8.0/1000000.0)/elapsed:0.0;
    snprintf(line,sizeof(line),"HTTP Range OK: bytes=%lld-%lld received=%lu total=%lld elapsed=%.3fs throughput=%.2fMbps%s",
      (long long)start,(long long)(start+(int64_t)out.used-1),(unsigned long)out.used,
      (long long)*known_size,elapsed,mbps,curl==r->worker_curl?" [prefetch]":" [read]");
    log_line(line);return 0;
}
static void schedule_prefetch_locked(RangeReader *r){
    if(r->worker_stop || r->worker_pending || r->worker_busy || r->next_ready || r->cache_start<0)return;
    int64_t next=r->cache_start+(int64_t)r->cache_len;
    if(r->file_size>0 && next>=r->file_size)return;
    r->request_start=next;r->request_generation=r->generation;
    r->worker_pending=1;pthread_cond_broadcast(&r->cond);
}
static void *range_prefetch_worker(void *opaque){
    RangeReader *r=opaque;
    for(;;){
        pthread_mutex_lock(&r->mutex);
        while(!r->worker_stop && !r->worker_pending)pthread_cond_wait(&r->cond,&r->mutex);
        if(r->worker_stop){pthread_mutex_unlock(&r->mutex);break;}
        int64_t start=r->request_start;unsigned long gen=r->request_generation;
        r->worker_pending=0;r->worker_busy=1;
        int64_t known=r->file_size;
        pthread_mutex_unlock(&r->mutex);
        size_t got=0;int rc=fetch_range_data(r,r->worker_curl,r->next_cache,start,&got,&known);
        pthread_mutex_lock(&r->mutex);
        if(gen==r->generation && rc>=0){
            r->next_start=start;r->next_len=got;r->file_size=known;r->next_ready=1;
        }else if(gen==r->generation && rc<0){
            snprintf(r->error,sizeof(r->error),"Background prefetch failed at byte %lld",(long long)start);
        }
        r->worker_busy=0;
        pthread_cond_broadcast(&r->cond);
        pthread_mutex_unlock(&r->mutex);
    }
    return NULL;
}
static int range_reader_start(RangeReader *r){
    if(pthread_mutex_init(&r->mutex,NULL)!=0)return AVERROR(EIO);
    if(pthread_cond_init(&r->cond,NULL)!=0){pthread_mutex_destroy(&r->mutex);return AVERROR(EIO);}
    r->sync_ready=1;r->cache_start=-1;r->next_start=-1;r->file_size=-1;
    r->cache=malloc(RANGE_CHUNK);r->next_cache=malloc(RANGE_CHUNK);
    r->curl=curl_easy_init();r->worker_curl=curl_easy_init();
    if(!r->cache||!r->next_cache||!r->curl||!r->worker_curl)return AVERROR(ENOMEM);
    size_t got=0;int64_t known=-1;
    int rc=fetch_range_data(r,r->curl,r->cache,0,&got,&known);
    if(rc<0)return rc;
    r->cache_start=0;r->cache_len=got;r->file_size=known;r->position=0;
    if(pthread_create(&r->worker,NULL,range_prefetch_worker,r)!=0)return AVERROR(EIO);
    r->worker_started=1;
    pthread_mutex_lock(&r->mutex);schedule_prefetch_locked(r);pthread_mutex_unlock(&r->mutex);
    log_line("Background HTTP Range prefetch enabled (two 8 MiB buffers)");
    return 0;
}
static void range_reader_stop(RangeReader *r){
    if(r->sync_ready){
        pthread_mutex_lock(&r->mutex);r->worker_stop=1;pthread_cond_broadcast(&r->cond);pthread_mutex_unlock(&r->mutex);
        if(r->worker_started)pthread_join(r->worker,NULL);
    }
    if(r->curl)curl_easy_cleanup(r->curl);
    if(r->worker_curl)curl_easy_cleanup(r->worker_curl);
    free(r->cache);free(r->next_cache);
    if(r->sync_ready){pthread_cond_destroy(&r->cond);pthread_mutex_destroy(&r->mutex);}
}
static int avio_read_packet_impl(void *opaque,uint8_t *buf,int buf_size){
    RangeReader *r=opaque;if(buf_size<=0)return 0;
    pthread_mutex_lock(&r->mutex);
    for(;;){
        if(r->file_size>0 && r->position>=r->file_size){pthread_mutex_unlock(&r->mutex);return AVERROR_EOF;}
        if(r->cache_start>=0 && r->position>=r->cache_start &&
           r->position<r->cache_start+(int64_t)r->cache_len)break;
        if(r->next_ready && r->position>=r->next_start &&
           r->position<r->next_start+(int64_t)r->next_len){
            uint8_t *tmp=r->cache;r->cache=r->next_cache;r->next_cache=tmp;
            r->cache_start=r->next_start;r->cache_len=r->next_len;
            r->next_start=-1;r->next_len=0;r->next_ready=0;
            schedule_prefetch_locked(r);continue;
        }
        int64_t target=r->position;
        r->generation++;r->worker_pending=0;r->next_ready=0;
        while(r->worker_busy)pthread_cond_wait(&r->cond,&r->mutex);
        pthread_mutex_unlock(&r->mutex);
        size_t got=0;int64_t known;
        pthread_mutex_lock(&r->mutex);known=r->file_size;pthread_mutex_unlock(&r->mutex);
        int fetch_rc=fetch_range_data(r,r->curl,r->cache,target,&got,&known);
        pthread_mutex_lock(&r->mutex);
        if(fetch_rc<0){pthread_mutex_unlock(&r->mutex);return fetch_rc;}
        r->cache_start=target;r->cache_len=got;r->file_size=known;
        schedule_prefetch_locked(r);
    }
    size_t offset=(size_t)(r->position-r->cache_start);
    size_t n=r->cache_len-offset;if(n>(size_t)buf_size)n=(size_t)buf_size;
    if(r->file_size>0 && (int64_t)n>r->file_size-r->position)n=(size_t)(r->file_size-r->position);
    memcpy(buf,r->cache+offset,n);r->position+=(int64_t)n;
    pthread_mutex_unlock(&r->mutex);return (int)n;
}
static int64_t monotonic_ns(void);
static int avio_read_packet(void *opaque,uint8_t *buf,int buf_size){
    int64_t started=monotonic_ns();
    int rc=avio_read_packet_impl(opaque,buf,buf_size);
    int64_t elapsed=monotonic_ns()-started;
    g_avio_read_total_ns+=elapsed;
    if(elapsed>g_avio_read_max_ns)g_avio_read_max_ns=elapsed;
    g_avio_read_calls++;
    if(rc>0)g_avio_read_bytes+=rc;
    return rc;
}
static int64_t range_seek_cb(void *opaque,int64_t offset,int whence){
    RangeReader *r=opaque;pthread_mutex_lock(&r->mutex);
    if(whence==AVSEEK_SIZE){int64_t z=r->file_size;pthread_mutex_unlock(&r->mutex);return z>0?z:AVERROR(ENOSYS);}
    whence &= ~AVSEEK_FORCE;int64_t next;
    if(whence==SEEK_SET)next=offset;
    else if(whence==SEEK_CUR)next=r->position+offset;
    else if(whence==SEEK_END && r->file_size>0)next=r->file_size+offset;
    else {pthread_mutex_unlock(&r->mutex);return AVERROR(EINVAL);}
    if(next<0){pthread_mutex_unlock(&r->mutex);return AVERROR(EINVAL);}
    r->position=next;pthread_mutex_unlock(&r->mutex);return next;
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
    int64_t pts_abs=p->pts==AV_NOPTS_VALUE?0:av_rescale_q(p->pts,tb,AV_TIME_BASE_Q);
    int64_t dts_abs=p->dts==AV_NOPTS_VALUE?pts_abs:av_rescale_q(p->dts,tb,AV_TIME_BASE_Q);
    int64_t pts=pts_abs-origin_us;
    int64_t dts=dts_abs-origin_us;
    int64_t duration_us=p->duration>0?av_rescale_q(p->duration,tb,AV_TIME_BASE_Q):0;
    if(pts<0)pts=0;if(dts<0)dts=0;
    if(g_diag_last_dts_us!=AV_NOPTS_VALUE){
        int64_t delta=dts_abs-g_diag_last_dts_us;
        if(delta>0){
            g_diag_dts_delta_sum_us+=delta;
            if(delta<g_diag_dts_delta_min_us)g_diag_dts_delta_min_us=delta;
            if(delta>g_diag_dts_delta_max_us)g_diag_dts_delta_max_us=delta;
        }
    }
    g_diag_last_dts_us=dts_abs;
    int64_t pts_offset=pts_abs-dts_abs;
    g_diag_pts_offset_sum_us+=pts_offset;
    if(pts_offset<g_diag_pts_offset_min_us)g_diag_pts_offset_min_us=pts_offset;
    if(pts_offset>g_diag_pts_offset_max_us)g_diag_pts_offset_max_us=pts_offset;
    g_diag_duration_sum_us+=duration_us;
    g_diag_timed_frames++;
    if(*clock_origin==0)*clock_origin=monotonic_ns()-dts*1000LL;
    int64_t target_ns=*clock_origin+dts*1000LL;
    int64_t before_wait=monotonic_ns();
    int64_t wait_ns=target_ns>before_wait?target_ns-before_wait:0;
    int64_t late_ns=before_wait>target_ns?before_wait-target_ns:0;
    g_diag_wait_total_ns+=wait_ns;if(wait_ns>g_diag_wait_max_ns)g_diag_wait_max_ns=wait_ns;
    g_diag_late_total_ns+=late_ns;if(late_ns>g_diag_late_max_ns)g_diag_late_max_ns=late_ns;
    wait_until(target_ns);
    for(int i=0;i<MAX_FEED_RETRIES;i++){
        int64_t call_start=monotonic_ns();
        int rc=NDL_DirectVideoPlay(p->data,(unsigned int)p->size,(long long)pts);
        int64_t call_ns=monotonic_ns()-call_start;
        g_feed_call_total_ns+=call_ns;if(call_ns>g_feed_call_max_ns)g_feed_call_max_ns=call_ns;
        *last_rc=rc;if(rc==0){if(i>0)g_feed_retries+=i;return 1;}
        sleep_ns(FEED_BACKOFF_NS);
    }g_feed_retries+=MAX_FEED_RETRIES;return 0;
}
static int drain_bsf(AVBSFContext *bsf,AVRational tb,int64_t origin_us,int64_t *clock_origin,long *frames){
    AVPacket *out=av_packet_alloc();if(!out)return AVERROR(ENOMEM);
    int last=0,result=0;
    while((result=av_bsf_receive_packet(bsf,out))>=0){
        if(g_diag_packet_samples<24){
            char sample[320];
            int64_t dts_us=out->dts==AV_NOPTS_VALUE?AV_NOPTS_VALUE:av_rescale_q(out->dts,tb,AV_TIME_BASE_Q);
            int64_t pts_us=out->pts==AV_NOPTS_VALUE?AV_NOPTS_VALUE:av_rescale_q(out->pts,tb,AV_TIME_BASE_Q);
            int64_t dur_us=out->duration>0?av_rescale_q(out->duration,tb,AV_TIME_BASE_Q):0;
            snprintf(sample,sizeof(sample),"BSF_SAMPLE n=%ld tb=%d/%d pts=%lld dts=%lld duration=%lld pts_ms=%.3f dts_ms=%.3f duration_ms=%.3f size=%d",
              g_diag_packet_samples,tb.num,tb.den,(long long)out->pts,(long long)out->dts,(long long)out->duration,
              pts_us==AV_NOPTS_VALUE?-1.0:pts_us/1000.0,dts_us==AV_NOPTS_VALUE?-1.0:dts_us/1000.0,dur_us/1000.0,out->size);
            log_line(sample);g_diag_packet_samples++;
        }
        if(!feed_frame(out,tb,origin_us,clock_origin,&last)){
            char s[300];const char *e=NDL_DirectMediaGetError();
            snprintf(s,sizeof(s),"NDL_DirectVideoPlay failed frame=%ld size=%d rc=%d error=%s",
              *frames,out->size,last,e?e:"(none)");log_line(s);av_packet_free(&out);return AVERROR(EIO);
        }
        (*frames)++;
        if(g_feed_window_start==0)g_feed_window_start=monotonic_ns();
        g_feed_calls++;
        if((*frames)%120==0){
            int64_t now=monotonic_ns();double sec=(now-g_feed_window_start)/1e9;
            double dts_avg=g_diag_timed_frames>1?(double)g_diag_dts_delta_sum_us/(g_diag_timed_frames-1):0.0;
            double pts_avg=g_diag_timed_frames?(double)g_diag_pts_offset_sum_us/g_diag_timed_frames:0.0;
            double wait_avg=g_diag_timed_frames?(double)g_diag_wait_total_ns/g_diag_timed_frames/1e6:0.0;
            double late_avg=g_diag_timed_frames?(double)g_diag_late_total_ns/g_diag_timed_frames/1e6:0.0;
            double avio_avg=g_avio_read_calls?(double)g_avio_read_total_ns/g_avio_read_calls/1e6:0.0;
            char stat[640];snprintf(stat,sizeof(stat),
              "PERF frames=%ld window_fps=%.2f feed_avg_ms=%.3f feed_max_ms=%.3f retries=%ld packet_bytes=%d",
              *frames,sec>0?120.0/sec:0.0,g_feed_calls?((double)g_feed_call_total_ns/g_feed_calls)/1e6:0.0,
              (double)g_feed_call_max_ns/1e6,g_feed_retries,out->size);
            log_line(stat);
            snprintf(stat,sizeof(stat),
              "TIMING frames=%ld dts_delta_avg_ms=%.3f dts_delta_min_ms=%.3f dts_delta_max_ms=%.3f pts_minus_dts_avg_ms=%.3f pts_min_ms=%.3f pts_max_ms=%.3f packet_duration_avg_ms=%.3f wait_avg_ms=%.3f wait_max_ms=%.3f late_avg_ms=%.3f late_max_ms=%.3f avio_read_avg_ms=%.3f avio_read_max_ms=%.3f avio_calls=%ld avio_bytes=%ld",
              *frames,dts_avg/1000.0,g_diag_dts_delta_min_us==INT64_MAX?0.0:g_diag_dts_delta_min_us/1000.0,
              g_diag_dts_delta_max_us/1000.0,pts_avg/1000.0,
              g_diag_pts_offset_min_us==INT64_MAX?0.0:g_diag_pts_offset_min_us/1000.0,
              g_diag_pts_offset_max_us==INT64_MIN?0.0:g_diag_pts_offset_max_us/1000.0,
              g_diag_timed_frames?(double)g_diag_duration_sum_us/g_diag_timed_frames/1000.0:0.0,
              wait_avg,g_diag_wait_max_ns/1e6,late_avg,g_diag_late_max_ns/1e6,
              avio_avg,g_avio_read_max_ns/1e6,g_avio_read_calls,g_avio_read_bytes);
            log_line(stat);
            g_feed_window_start=now;g_feed_call_total_ns=0;g_feed_call_max_ns=0;g_feed_calls=0;g_feed_retries=0;
            g_diag_last_dts_us=AV_NOPTS_VALUE;g_diag_dts_delta_sum_us=0;g_diag_dts_delta_min_us=INT64_MAX;g_diag_dts_delta_max_us=0;
            g_diag_pts_offset_sum_us=0;g_diag_pts_offset_min_us=INT64_MAX;g_diag_pts_offset_max_us=INT64_MIN;
            g_diag_wait_total_ns=0;g_diag_wait_max_ns=0;g_diag_late_total_ns=0;g_diag_late_max_ns=0;g_diag_duration_sum_us=0;g_diag_timed_frames=0;
            g_avio_read_total_ns=0;g_avio_read_max_ns=0;g_avio_read_calls=0;g_avio_read_bytes=0;
        }
        av_packet_unref(out);
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
    if(curl_global_init(CURL_GLOBAL_DEFAULT)!=CURLE_OK){log_line("curl global init failed");return 3;}
    RangeReader rr={0};rr.url=url;
    if(range_reader_start(&rr)<0){log_line("Cannot initialize asynchronous HTTP Range reader");range_reader_stop(&rr);curl_global_cleanup();return 3;}
    AVFormatContext *fmt=avformat_alloc_context();uint8_t *avio_buf=av_malloc(AVIO_BUFFER);
    AVIOContext *avio=avio_alloc_context(avio_buf,AVIO_BUFFER,0,&rr,avio_read_packet,NULL,range_seek_cb);
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
    char meta[384];snprintf(meta,sizeof(meta),"MKV opened: %dx%d profile=%d time_base=%d/%d avg_frame_rate=%d/%d r_frame_rate=%d/%d duration=%lld",
      st->codecpar->width,st->codecpar->height,st->codecpar->profile,st->time_base.num,st->time_base.den,
      st->avg_frame_rate.num,st->avg_frame_rate.den,st->r_frame_rate.num,st->r_frame_rate.den,
      (long long)fmt->duration);log_line(meta);
    AVBSFContext *bsf=NULL;
    /* Match the proven TV probe: Annex-B conversion plus an AUD before each access unit. */
    rc=av_bsf_list_parse_str("hevc_mp4toannexb,hevc_metadata=aud=insert",&bsf);
    if(rc<0||!bsf){log_line("Cannot create HEVC Annex-B + AUD bitstream filter chain");goto fail_early;}
    if(avcodec_parameters_copy(bsf->par_in,st->codecpar)<0){log_line("Cannot copy HEVC codec parameters into bitstream filter chain");av_bsf_free(&bsf);goto fail_early;}
    bsf->time_base_in=st->time_base;
    if(av_bsf_init(bsf)<0){log_line("Cannot initialize HEVC Annex-B + AUD filter chain");av_bsf_free(&bsf);goto fail_early;}
    {char tbline[160];snprintf(tbline,sizeof(tbline),"BSF_TIME_BASE input=%d/%d output=%d/%d",
      bsf->time_base_in.num,bsf->time_base_in.den,bsf->time_base_out.num,bsf->time_base_out.den);log_line(tbline);}
    log_line("HEVC filter chain enabled: Annex-B conversion + AUD insertion");

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
    int demux_rc=0;const char *stop_reason="demux-ended";
    while((demux_rc=av_read_frame(fmt,packet))>=0){
        if(packet->stream_index==video){
            if(origin_us==AV_NOPTS_VALUE){
                int64_t first=packet->dts!=AV_NOPTS_VALUE?packet->dts:packet->pts;
                origin_us=first==AV_NOPTS_VALUE?0:av_rescale_q(first,st->time_base,AV_TIME_BASE_Q);
            }
            if(g_diag_packet_samples<12){
                char sample[256];snprintf(sample,sizeof(sample),"DEMUX_SAMPLE n=%ld tb=%d/%d pts=%lld dts=%lld duration=%lld size=%d",
                  g_diag_packet_samples,st->time_base.num,st->time_base.den,(long long)packet->pts,
                  (long long)packet->dts,(long long)packet->duration,packet->size);log_line(sample);
            }
            rc=av_bsf_send_packet(bsf,packet);
            if(rc<0){log_line("HEVC bitstream filter rejected packet");failed=1;av_packet_unref(packet);break;}
            rc=drain_bsf(bsf,bsf->time_base_out,origin_us,&clock_origin,&frames);
            if(rc<0){failed=1;av_packet_unref(packet);break;}
        }
        av_packet_unref(packet);
        if(SDL_QuitRequested()){failed=2;stop_reason="user-quit";break;}
    }
    if(!failed && demux_rc<0 && demux_rc!=AVERROR_EOF){char e[256];av_strerror(demux_rc,e,sizeof(e));stop_reason="demux-error";log_line(e);}
    else if(demux_rc==AVERROR_EOF)stop_reason="eof";
    if(!failed){
        av_bsf_send_packet(bsf,NULL);
        if(drain_bsf(bsf,bsf->time_base_out,origin_us==AV_NOPTS_VALUE?0:origin_us,&clock_origin,&frames)<0)failed=1;
    }
    av_packet_free(&packet);
    {char s[320];snprintf(s,sizeof(s),"Stream ended: frames=%ld LOADCOMPLETED=%s PLAYING=%s demux_rc=%d stop_reason=%s",
      frames,g_load_completed?"yes":"no",g_playing?"yes":"no",demux_rc,stop_reason);log_line(s);}
    if(!frames)failed=1;
    if(failed==1 || failed==2){char id[16]={0};int up=upload_log(id,sizeof(id));char d[160];snprintf(d,sizeof(d),"Playback diagnostic uploaded=%s id=%s",up?"yes":"no",up?id:"none");log_line(d);}
    if(failed==0){
        sleep_ns(1500000000LL);NDL_DirectMediaUnload();NDL_DirectMediaQuit();
        char id[16]={0};int up=upload_log(id,sizeof(id));(void)up;
    }else{NDL_DirectMediaUnload();NDL_DirectMediaQuit();}
    av_bsf_free(&bsf);SDL_DestroyRenderer(renderer);SDL_DestroyWindow(window);SDL_Quit();
    avformat_close_input(&fmt);if(avio)avio_context_free(&avio);range_reader_stop(&rr);curl_global_cleanup();
    return failed==1?10:0;

fail_ui:
    SDL_DestroyRenderer(renderer);SDL_DestroyWindow(window);SDL_Quit();av_bsf_free(&bsf);
fail_early:
    {char s[300];snprintf(s,sizeof(s),"STREAM FAILED: %s",rr.error[0]?rr.error:"see preceding FFmpeg/NDL diagnostic");log_line(s);
     char id[16]={0};upload_log(id,sizeof(id));}
    if(fmt)avformat_close_input(&fmt);if(avio)avio_context_free(&avio);
    range_reader_stop(&rr);curl_global_cleanup();return 11;
}
