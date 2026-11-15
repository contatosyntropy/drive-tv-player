cmake_minimum_required(VERSION 3.16)
project(drive_tv_native_media_probe LANGUAGES C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(SDL2 REQUIRED sdl2)
pkg_check_modules(NDL_DIRECTMEDIA REQUIRED NDL_directmedia)

add_executable(drive-tv-native-media-probe src/main.c)
target_include_directories(drive-tv-native-media-probe PRIVATE
  ${SDL2_INCLUDE_DIRS}
  ${NDL_DIRECTMEDIA_INCLUDE_DIRS}
)
target_compile_options(drive-tv-native-media-probe PRIVATE
  ${SDL2_CFLAGS_OTHER}
  ${NDL_DIRECTMEDIA_CFLAGS_OTHER}
  -Wno-error=deprecated-declarations
)
target_link_directories(drive-tv-native-media-probe PRIVATE
  ${SDL2_LIBRARY_DIRS}
  ${NDL_DIRECTMEDIA_LIBRARY_DIRS}
)
target_link_libraries(drive-tv-native-media-probe PRIVATE
  ${SDL2_LIBRARIES}
  ${NDL_DIRECTMEDIA_LIBRARIES}
  pthread
)
set_target_properties(drive-tv-native-media-probe PROPERTIES
  INSTALL_RPATH "$ORIGIN"
  BUILD_WITH_INSTALL_RPATH TRUE
)