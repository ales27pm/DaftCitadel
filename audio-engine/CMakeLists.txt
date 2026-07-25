cmake_minimum_required(VERSION 3.16)
project(DaftAudioEngine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(DAFT_AUDIO_ENGINE_BUILD_TESTS "Build Daft Audio Engine unit tests" OFF)
option(DAFT_AUDIO_ENGINE_ENABLE_SANITIZERS "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)

add_library(daft_audio_engine
    src/AudioBuffer.cpp
    src/DSPNode.cpp
    src/Scheduler.cpp
    src/SceneGraph.cpp
    src/RealtimeControlPlane.cpp
    src/Automation.cpp
    src/Clock.cpp
    src/PluginHost.cpp
    src/PluginNode.cpp
    src/instruments/InstrumentNode.cpp
    src/instruments/juno/Juno106Node.cpp
    src/instruments/juno/JunoDSPEngine.cpp
    src/instruments/juno/JunoVoice.cpp
    platform/common/NodeFactory.cpp
)

target_include_directories(daft_audio_engine
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

target_compile_options(daft_audio_engine PRIVATE -Wall -Wextra -Wpedantic)

if(DAFT_AUDIO_ENGINE_ENABLE_SANITIZERS)
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options(daft_audio_engine PRIVATE
            -fsanitize=address,undefined
            -fno-sanitize-recover=all
            -fno-omit-frame-pointer
        )
        target_link_options(daft_audio_engine PRIVATE
            -fsanitize=address,undefined
            -fno-omit-frame-pointer
        )
    else()
        message(FATAL_ERROR "DAFT_AUDIO_ENGINE_ENABLE_SANITIZERS requires Clang or GCC")
    endif()
endif()

if(DAFT_AUDIO_ENGINE_BUILD_TESTS)
    enable_testing()
    find_package(Threads REQUIRED)
    add_executable(daft_audio_engine_tests
        tests/TestMain.cpp
        tests/SchedulerTests.cpp
        tests/ClipPlayerNodeTests.cpp
        tests/PluginNodeTests.cpp
        tests/SceneGraphTests.cpp
        tests/JunoCoreTests.cpp
        tests/InstrumentNodeTests.cpp
        tests/RealtimeControlQueueTests.cpp
        tests/RealtimeControlPlaneTests.cpp
    )
    target_link_libraries(daft_audio_engine_tests PRIVATE daft_audio_engine Threads::Threads)
    if(DAFT_AUDIO_ENGINE_ENABLE_SANITIZERS)
        target_compile_options(daft_audio_engine_tests PRIVATE
            -fsanitize=address,undefined
            -fno-sanitize-recover=all
            -fno-omit-frame-pointer
        )
        target_link_options(daft_audio_engine_tests PRIVATE
            -fsanitize=address,undefined
            -fno-omit-frame-pointer
        )
    endif()
    add_test(NAME AudioEngineTests COMMAND daft_audio_engine_tests)
endif()
