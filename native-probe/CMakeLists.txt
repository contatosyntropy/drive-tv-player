cmake_minimum_required(VERSION 3.16)
project(drive_tv_native_probe LANGUAGES C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(SDL2 REQUIRED sdl2)

add_executable(drive-tv-native-probe src/main.c)
target_include_directories(drive-tv-native-probe PRIVATE ${SDL2_INCLUDE_DIRS})
target_compile_options(drive-tv-native-probe PRIVATE ${SDL2_CFLAGS_OTHER})
target_link_directories(drive-tv-native-probe PRIVATE ${SDL2_LIBRARY_DIRS})
target_link_libraries(drive-tv-native-probe PRIVATE ${SDL2_LIBRARIES})
