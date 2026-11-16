cmake_minimum_required(VERSION 3.16)
project(drive_tv_native_stream_player LANGUAGES C)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(SDL2 REQUIRED sdl2)
pkg_check_modules(CURL REQUIRED libcurl)
pkg_check_modules(NDL_DIRECTMEDIA QUIET NDL_directmedia)

if(NDL_DIRECTMEDIA_FOUND)
  set(NDL_INCLUDE_DIRS ${NDL_DIRECTMEDIA_INCLUDE_DIRS})
  set(NDL_LIBRARY_DIRS ${NDL_DIRECTMEDIA_LIBRARY_DIRS})
  set(NDL_LIBRARIES ${NDL_DIRECTMEDIA_LIBRARIES})
else()
  include(FetchContent)
  FetchContent_Declare(webos_userland
    GIT_REPOSITORY https://github.com/webosbrew/webos-userland.git
    GIT_TAG main
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR do-not-add-this-project
  )
  FetchContent_MakeAvailable(webos_userland)
  add_library(NDL_directmedia SHARED "${webos_userland_SOURCE_DIR}/src/dummy.c")
  set_target_properties(NDL_directmedia PROPERTIES OUTPUT_NAME NDL_directmedia SOVERSION 1)
  target_link_options(NDL_directmedia PRIVATE "${webos_userland_SOURCE_DIR}/src/NDL_directmedia.lds")
  set(NDL_INCLUDE_DIRS "${webos_userland_SOURCE_DIR}/include/libndl-media")
  set(NDL_LIBRARIES NDL_directmedia)
endif()

set(FFMPEG_ROOT "" CACHE PATH "Prefix containing target FFmpeg headers and static libraries")
if(NOT EXISTS "${FFMPEG_ROOT}/include/libavformat/avformat.h")
  message(FATAL_ERROR "FFMPEG_ROOT must contain target FFmpeg headers")
endif()

add_executable(drive-tv-native-stream-player stream_main.c)
target_include_directories(drive-tv-native-stream-player PRIVATE
  ${SDL2_INCLUDE_DIRS} ${CURL_INCLUDE_DIRS} ${NDL_INCLUDE_DIRS}
  "${FFMPEG_ROOT}/include"
)
target_compile_options(drive-tv-native-stream-player PRIVATE
  ${SDL2_CFLAGS_OTHER} ${CURL_CFLAGS_OTHER} -Wno-error=deprecated-declarations
)
target_link_directories(drive-tv-native-stream-player PRIVATE
  ${SDL2_LIBRARY_DIRS} ${CURL_LIBRARY_DIRS} ${NDL_LIBRARY_DIRS}
  "${FFMPEG_ROOT}/lib"
)
target_link_libraries(drive-tv-native-stream-player PRIVATE
  avformat avcodec avutil
  ${SDL2_LIBRARIES} ${NDL_LIBRARIES} ${CURL_LIBRARIES}
  pthread z m dl
)
set_target_properties(drive-tv-native-stream-player PROPERTIES
  INSTALL_RPATH "$ORIGIN" BUILD_WITH_INSTALL_RPATH TRUE
)
