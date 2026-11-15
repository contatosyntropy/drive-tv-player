cmake_minimum_required(VERSION 3.16)
project(drive_tv_native_media_probe LANGUAGES C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(SDL2 REQUIRED sdl2)
pkg_check_modules(NDL_DIRECTMEDIA QUIET NDL_directmedia)

if(NDL_DIRECTMEDIA_FOUND)
  set(NDL_INCLUDE_DIRS ${NDL_DIRECTMEDIA_INCLUDE_DIRS})
  set(NDL_LIBRARY_DIRS ${NDL_DIRECTMEDIA_LIBRARY_DIRS})
  set(NDL_LIBRARIES ${NDL_DIRECTMEDIA_LIBRARIES})
else()
  # The Buildroot SDK used by CI omits LG's proprietary NDL development files.
  # Use webos-userland's public declarations and link-only stub. The stub is
  # deliberately NOT packaged; the TV supplies the real libNDL_directmedia.so.1.
  include(FetchContent)
  FetchContent_Declare(webos_userland
    GIT_REPOSITORY https://github.com/webosbrew/webos-userland.git
    GIT_TAG main
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR do-not-add-this-project
  )
  FetchContent_MakeAvailable(webos_userland)
  add_library(NDL_directmedia SHARED "${webos_userland_SOURCE_DIR}/src/dummy.c")
  set_target_properties(NDL_directmedia PROPERTIES
    OUTPUT_NAME NDL_directmedia
    SOVERSION 1
  )
  target_link_options(NDL_directmedia PRIVATE
    "${webos_userland_SOURCE_DIR}/src/NDL_directmedia.lds"
  )
  set(NDL_INCLUDE_DIRS "${webos_userland_SOURCE_DIR}/include/libndl-media")
  set(NDL_LIBRARY_DIRS "")
  set(NDL_LIBRARIES NDL_directmedia)
endif()

add_executable(drive-tv-native-media-probe src/main.c)
target_include_directories(drive-tv-native-media-probe PRIVATE
  ${SDL2_INCLUDE_DIRS}
  ${NDL_INCLUDE_DIRS}
)
target_compile_options(drive-tv-native-media-probe PRIVATE
  ${SDL2_CFLAGS_OTHER}
  ${NDL_DIRECTMEDIA_CFLAGS_OTHER}
  -Wno-error=deprecated-declarations
)
target_link_directories(drive-tv-native-media-probe PRIVATE
  ${SDL2_LIBRARY_DIRS}
  ${NDL_LIBRARY_DIRS}
)
target_link_libraries(drive-tv-native-media-probe PRIVATE
  ${SDL2_LIBRARIES}
  ${NDL_LIBRARIES}
  pthread
)
set_target_properties(drive-tv-native-media-probe PROPERTIES
  INSTALL_RPATH "$ORIGIN"
  BUILD_WITH_INSTALL_RPATH TRUE
)