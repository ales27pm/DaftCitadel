cmake_minimum_required(VERSION 3.16)
project(DaftAudioEngine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(DAFT_AUDIO_ENGINE_BUILD_TESTS "Build Daft Audio Engine unit tests" OFF)

add_library(daft_audio_engine
    src/AudioBuffer.cpp
    src/DSPNode.cpp
    src/Scheduler.cpp
    src/SceneGraph.cpp
    src/Automation.cpp
    src/Clock.cpp
    src/PluginHost.cpp
    src/PluginNode.cpp
)

target_include_directories(daft_audio_engine
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

target_compile_options(daft_audio_engine PRIVATE -Wall -Wextra -Wpedantic)

if(DAFT_AUDIO_ENGINE_BUILD_TESTS)
    enable_testing()
    add_executable(daft_audio_engine_tests
        tests/TestMain.cpp
        tests/SchedulerTests.cpp
        tests/ClipPlayerNodeTests.cpp
        tests/PluginNodeTests.cpp
    )
    target_link_libraries(daft_audio_engine_tests PRIVATE daft_audio_engine)
    add_test(NAME AudioEngineTests COMMAND daft_audio_engine_tests)
endif()
