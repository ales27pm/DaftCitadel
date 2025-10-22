#include <jni.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>

#include "audio-engine/platform/android/AudioEngineBridge.h"
#include "audio-engine/platform/common/NodeFactory.h"
#include "audio_engine/SceneGraph.h"

using daft::audio::bridge::AudioEngineBridge;
using daft::audio::bridge::CreateNode;
using daft::audio::bridge::NodeOptions;

namespace {

/**
 * @brief Converts a Java UTF-8 string to a C++ std::string.
 *
 * If `value` is null, returns an empty string.
 *
 * @param value Java `jstring` to convert; may be null.
 * @return std::string UTF-8 encoded copy of `value`'s characters, or an empty string if `value` is null.
 */
std::string ToStdString(JNIEnv* env, jstring value) {
  if (value == nullptr) {
    return std::string();
  }
  const char* utfChars = env->GetStringUTFChars(value, nullptr);
  std::string result = utfChars ? utfChars : "";
  if (utfChars != nullptr) {
    env->ReleaseStringUTFChars(value, utfChars);
  }
  return result;
}

/**
 * Produce a lowercase copy of the input string.
 *
 * @return A copy of `key` with all characters converted to lowercase.
 */
std::string NormalizeKey(const std::string& key) {
  std::string normalized = key;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return normalized;
}

/**
 * @brief Throws a Java exception of the specified class with the provided message.
 *
 * Locates the Java exception class named by `className` and, if found, throws a new
 * instance of that exception with `message` as the detail message. If the exception
 * class cannot be found, the function returns without throwing.
 *
 * @param env JNI environment pointer used to find and throw the exception.
 * @param className Fully-qualified JNI class name of the Java exception (e.g. "java/lang/RuntimeException").
 * @param message Detail message to use for the thrown Java exception.
 */
void ThrowJavaException(JNIEnv* env, const char* className, const std::string& message) {
  jclass exceptionClass = env->FindClass(className);
  if (exceptionClass == nullptr) {
    return;
  }
  env->ThrowNew(exceptionClass, message.c_str());
  env->DeleteLocalRef(exceptionClass);
}

/**
 * @brief Converts a Java Map<String, Object> into a NodeOptions map with numeric values.
 *
 * Keys are normalized to lowercase; values are converted to doubles when possible:
 * - Java Numbers are stored as their double value.
 * - Java Booleans are stored as `1.0` for `true` and `0.0` for `false`.
 * - Java Strings are parsed as doubles and stored if parsing succeeds; unparsable strings are ignored.
 *
 * @param env JNI environment pointer.
 * @param map Java `java.util.Map<String, Object>` instance to convert. If `nullptr`, an empty NodeOptions is returned.
 * @return NodeOptions A map from normalized (lowercase) keys to double values representing the converted entries.
 */
NodeOptions ConvertOptions(JNIEnv* env, jobject map) {
  NodeOptions options;
  if (map == nullptr) {
    return options;
  }

  jclass mapClass = env->GetObjectClass(map);
  jmethodID entrySetMethod = env->GetMethodID(mapClass, "entrySet", "()Ljava/util/Set;");
  jobject entrySet = env->CallObjectMethod(map, entrySetMethod);
  env->DeleteLocalRef(mapClass);

  jclass setClass = env->GetObjectClass(entrySet);
  jmethodID iteratorMethod = env->GetMethodID(setClass, "iterator", "()Ljava/util/Iterator;");
  jobject iterator = env->CallObjectMethod(entrySet, iteratorMethod);
  env->DeleteLocalRef(setClass);
  env->DeleteLocalRef(entrySet);

  jclass iteratorClass = env->GetObjectClass(iterator);
  jmethodID hasNextMethod = env->GetMethodID(iteratorClass, "hasNext", "()Z");
  jmethodID nextMethod = env->GetMethodID(iteratorClass, "next", "()Ljava/lang/Object;");

  jclass entryClass = env->FindClass("java/util/Map$Entry");
  jmethodID getKeyMethod = env->GetMethodID(entryClass, "getKey", "()Ljava/lang/Object;");
  jmethodID getValueMethod = env->GetMethodID(entryClass, "getValue", "()Ljava/lang/Object;");

  jclass numberClass = env->FindClass("java/lang/Number");
  jmethodID doubleValueMethod = env->GetMethodID(numberClass, "doubleValue", "()D");
  jclass booleanClass = env->FindClass("java/lang/Boolean");
  jmethodID booleanValueMethod = env->GetMethodID(booleanClass, "booleanValue", "()Z");
  jclass stringClass = env->FindClass("java/lang/String");

  while (env->CallBooleanMethod(iterator, hasNextMethod) == JNI_TRUE) {
    jobject entry = env->CallObjectMethod(iterator, nextMethod);
    jstring keyObject = static_cast<jstring>(env->CallObjectMethod(entry, getKeyMethod));
    jobject valueObject = env->CallObjectMethod(entry, getValueMethod);

    std::string key = NormalizeKey(ToStdString(env, keyObject));

    if (valueObject != nullptr) {
      if (env->IsInstanceOf(valueObject, numberClass) == JNI_TRUE) {
        const double numeric = env->CallDoubleMethod(valueObject, doubleValueMethod);
        options[key] = numeric;
      } else if (env->IsInstanceOf(valueObject, booleanClass) == JNI_TRUE) {
        const jboolean flag = env->CallBooleanMethod(valueObject, booleanValueMethod);
        options[key] = flag ? 1.0 : 0.0;
      } else if (env->IsInstanceOf(valueObject, stringClass) == JNI_TRUE) {
        auto str = ToStdString(env, static_cast<jstring>(valueObject));
        try {
          options[key] = std::stod(str);
        } catch (const std::exception&) {
          // ignore strings that cannot be parsed into numbers
        }
      }
    }

    env->DeleteLocalRef(keyObject);
    env->DeleteLocalRef(valueObject);
    env->DeleteLocalRef(entry);
  }

  env->DeleteLocalRef(iteratorClass);
  env->DeleteLocalRef(iterator);
  env->DeleteLocalRef(entryClass);
  env->DeleteLocalRef(numberClass);
  env->DeleteLocalRef(booleanClass);
  env->DeleteLocalRef(stringClass);

  return options;
}

}  // namespace

extern "C" {

/**
 * @brief Initialize the native audio engine with the specified sample rate and buffer size.
 *
 * @param sampleRate Audio sample rate in Hz.
 * @param framesPerBuffer Number of frames per audio buffer.
 *
 * @throws java.lang.RuntimeException if engine initialization fails.
 */
JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeInitialize(JNIEnv* env, jobject /*thiz*/, jdouble sampleRate,
                                                             jint framesPerBuffer) {
  try {
    AudioEngineBridge::initialize(env, sampleRate, static_cast<std::uint32_t>(framesPerBuffer));
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/RuntimeException", ex.what());
  }
}

/**
 * @brief Shuts down the global native audio engine bridge.
 *
 * Attempts to stop and clean up the native audio engine; on failure, throws a Java RuntimeException containing the native exception message.
 *
 * @param env JNI environment pointer.
 * @param thiz Unused Java object reference.
 *
 * @throws java.lang.RuntimeException If the native shutdown raises an exception.
 */
JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeShutdown(JNIEnv* env, jobject /*thiz*/) {
  try {
    AudioEngineBridge::shutdown();
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/RuntimeException", ex.what());
  }
}

/**
 * @brief Creates a native audio node from Java parameters and adds it to the engine.
 *
 * Converts the provided Java nodeId, nodeType, and options map into native types,
 * constructs the requested node, and registers it with the AudioEngineBridge.
 *
 * @param nodeId Java string identifier for the node; must be non-empty.
 * @param nodeType Java string specifying the node type; must be non-empty.
 * @param optionsMap Java Map<String,Object> of node options; may be null for defaults.
 *
 * @throws java.lang.IllegalArgumentException if nodeId or nodeType is empty or node creation fails.
 * @throws java.lang.IllegalStateException if the node cannot be added to the audio engine.
 */
JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeAddNode(JNIEnv* env, jobject /*thiz*/, jstring nodeId, jstring nodeType,
                                                          jobject optionsMap) {
  const std::string id = ToStdString(env, nodeId);
  const std::string type = ToStdString(env, nodeType);
  if (id.empty() || type.empty()) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "nodeId and nodeType are required");
    return;
  }

  NodeOptions options = ConvertOptions(env, optionsMap);
  std::string error;
  auto node = CreateNode(type, options, error);
  if (!node) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", error);
    return;
  }
  if (!AudioEngineBridge::addNode(id, std::move(node))) {
    ThrowJavaException(env, "java/lang/IllegalStateException", "Failed to add node '" + id + "'");
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeRegisterClipBuffer(JNIEnv* env, jobject /*thiz*/, jstring bufferKey,
                                                                      jdouble sampleRate, jint channels, jint frames,
                                                                      jobjectArray channelData) {
  const std::string key = ToStdString(env, bufferKey);
  if (key.empty()) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "bufferKey is required");
    return;
  }
  if (!std::isfinite(sampleRate) || sampleRate <= 0.0) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "sampleRate must be positive and finite");
    return;
  }
  if (channels <= 0 || frames <= 0) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "channels and frames must be positive integers");
    return;
  }
  if (channelData == nullptr) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "channelData is required");
    return;
  }
  const jsize providedChannels = env->GetArrayLength(channelData);
  if (providedChannels != channels) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "channelData length must equal channels");
    return;
  }

  const std::size_t channelCount = static_cast<std::size_t>(channels);
  const std::size_t frameCount = static_cast<std::size_t>(frames);

  std::vector<std::vector<float>> nativeChannels;
  nativeChannels.reserve(channelCount);

  for (jsize index = 0; index < channels; ++index) {
    jfloatArray channelArray = static_cast<jfloatArray>(env->GetObjectArrayElement(channelData, index));
    if (channelArray == nullptr) {
      ThrowJavaException(env, "java/lang/IllegalArgumentException", "channelData contains null entries");
      return;
    }
    const jsize length = env->GetArrayLength(channelArray);
    if (length < frames) {
      env->DeleteLocalRef(channelArray);
      ThrowJavaException(env, "java/lang/IllegalArgumentException", "channelData entry is shorter than frames");
      return;
    }
    std::vector<float> channel(frameCount);
    env->GetFloatArrayRegion(channelArray, 0, frames, channel.data());
    nativeChannels.push_back(std::move(channel));
    env->DeleteLocalRef(channelArray);
  }

  if (!AudioEngineBridge::registerClipBuffer(key, sampleRate, channelCount, frameCount, std::move(nativeChannels))) {
    ThrowJavaException(env, "java/lang/IllegalStateException", "Failed to register clip buffer '" + key + "'");
  }
}

/**
 * @brief Remove a node from the native audio engine by its identifier.
 *
 * @param nodeId Java `jstring` containing the node identifier to remove.
 * @throws Java RuntimeException containing the native exception message if removal fails.
 */
JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeRemoveNode(JNIEnv* env, jobject /*thiz*/, jstring nodeId) {
  try {
    AudioEngineBridge::removeNode(ToStdString(env, nodeId));
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/RuntimeException", ex.what());
  }
}

/**
 * @brief Connects two nodes identified by Java strings.
 *
 * Attempts to connect the node with id `source` to the node with id `destination`.
 *
 * @param source Java `jstring` containing the source node id.
 * @param destination Java `jstring` containing the destination node id.
 *
 * @throws java/lang/IllegalStateException if the connection fails; message is "Failed to connect '<source>' -> '<destination>'".
 */
JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeConnectNodes(JNIEnv* env, jobject /*thiz*/, jstring source,
                                                                jstring destination) {
  const std::string src = ToStdString(env, source);
  const std::string dest = ToStdString(env, destination);
  if (!AudioEngineBridge::connect(src, dest)) {
    ThrowJavaException(env, "java/lang/IllegalStateException",
                       "Failed to connect '" + src + "' -> '" + dest + "'");
  }
}

/**
 * @brief Disconnects two nodes in the native audio engine.
 *
 * @param source Java `jstring` containing the source node identifier.
 * @param destination Java `jstring` containing the destination node identifier.
 *
 * @throws java/lang/RuntimeException if the native disconnect operation fails.
 */
JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeDisconnectNodes(JNIEnv* env, jobject /*thiz*/, jstring source,
                                                                   jstring destination) {
  try {
    AudioEngineBridge::disconnect(ToStdString(env, source), ToStdString(env, destination));
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/RuntimeException", ex.what());
  }
}

/**
 * @brief Schedule a parameter automation event for a node at a specific frame.
 *
 * @param nodeId Java string identifier of the target node.
 * @param parameter Java string name of the parameter to automate.
 * @param frame Frame index at which to apply the automation (converted to unsigned 64-bit).
 * @param value Parameter value to set at the specified frame.
 *
 * @throws java/lang/IllegalStateException if scheduling fails due to a native-side error.
 */
JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeScheduleAutomation(JNIEnv* env, jobject /*thiz*/, jstring nodeId,
                                                                      jstring parameter, jlong frame, jdouble value) {
  if (frame < 0) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "frame must be non-negative");
    return;
  }
  if (!std::isfinite(value)) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "value must be finite");
    return;
  }
  try {
    AudioEngineBridge::scheduleParameterAutomation(ToStdString(env, nodeId), ToStdString(env, parameter),
                                                   static_cast<std::uint64_t>(frame), value);
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

/**
 * @brief Retrieve runtime diagnostics from the audio engine.
 *
 * @return jdoubleArray A 2-element double array where element 0 is the number of xruns
 * (`diagnostics.xruns`) and element 1 is the last render duration in microseconds
 * (`diagnostics.lastRenderDurationMicros`). Returns `nullptr` if the Java array cannot be allocated.
 */
JNIEXPORT jdoubleArray JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeGetDiagnostics(JNIEnv* env, jobject /*thiz*/) {
  jdoubleArray result = env->NewDoubleArray(2);
  if (result == nullptr) {
    return nullptr;
  }
  const auto diagnostics = AudioEngineBridge::getDiagnostics();
  const jdouble payload[2] = {static_cast<jdouble>(diagnostics.xruns), diagnostics.lastRenderDurationMicros};
  env->SetDoubleArrayRegion(result, 0, 2, payload);
  return result;
}

/**
 * @brief Get the maximum supported frames per buffer for the audio scene graph.
 *
 * @return jint The maximum frames per buffer supported by the engine.
 */
JNIEXPORT jint JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeMaxFramesPerBuffer(JNIEnv*, jobject /*thiz*/) {
  return static_cast<jint>(daft::audio::SceneGraph::maxSupportedFramesPerBuffer());
}

}  // extern "C"