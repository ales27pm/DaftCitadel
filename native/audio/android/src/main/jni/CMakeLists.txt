cmake_minimum_required(VERSION 3.18)
project(DaftAudioEngineModule LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_POSITION_INDEPENDENT_CODE ON)

get_filename_component(PROJECT_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../../.." ABSOLUTE)
set(AUDIO_ENGINE_DIR "${PROJECT_ROOT}/audio-engine")

set(DAFT_AUDIO_ENGINE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${AUDIO_ENGINE_DIR} ${CMAKE_BINARY_DIR}/audio-engine)

add_library(daft_audio_engine_module SHARED
    AudioEngineModule.cpp
    ${AUDIO_ENGINE_DIR}/platform/android/AudioEngineBridge.cpp
)

target_include_directories(daft_audio_engine_module
    PRIVATE
        ${AUDIO_ENGINE_DIR}/include
        ${AUDIO_ENGINE_DIR}/platform/android
        ${AUDIO_ENGINE_DIR}/platform/common
)

target_link_libraries(daft_audio_engine_module
    PRIVATE
        daft_audio_engine
        log
)

target_compile_options(daft_audio_engine_module PRIVATE -Wall -Wextra -Wpedantic)
