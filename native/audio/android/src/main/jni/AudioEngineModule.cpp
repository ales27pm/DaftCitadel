#include <jni.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

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

std::string TrimCopy(std::string value) {
  const auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char c) {
    return std::isspace(c) != 0;
  });
  const auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char c) {
                    return std::isspace(c) != 0;
                  }).base();
  if (first >= last) {
    return std::string();
  }
  return std::string(first, last);
}

std::string ToLowerCopy(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
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
 * @brief Converts a Java Map<String, Object> into a NodeOptions structure.
 *
 * Keys are normalized to lowercase; values are converted to doubles when possible:
 * - Java Numbers are stored as their double value.
 * - Java Booleans are stored as `1.0` for `true` and `0.0` for `false`.
 * - Java Strings are trimmed; boolean-like strings ("true"/"yes"/"on" and "false"/"no"/"off")
 *   are converted to 1.0/0.0. Other strings are parsed as doubles when possible while
 *   preserving the original trimmed value in the string map.
 *
 * @param env JNI environment pointer.
 * @param map Java `java.util.Map<String, Object>` instance to convert. If `nullptr`, an empty NodeOptions is returned.
 * @return NodeOptions Populated with normalized keys stored via `setNumeric`/`setString`.
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
        options.setNumeric(key, numeric);
      } else if (env->IsInstanceOf(valueObject, booleanClass) == JNI_TRUE) {
        const jboolean flag = env->CallBooleanMethod(valueObject, booleanValueMethod);
        options.setNumeric(key, flag ? 1.0 : 0.0);
      } else if (env->IsInstanceOf(valueObject, stringClass) == JNI_TRUE) {
        std::string raw = ToStdString(env, static_cast<jstring>(valueObject));
        std::string trimmed = TrimCopy(std::move(raw));
        if (trimmed.empty()) {
          // Ignore empty strings.
        } else {
          options.setString(key, trimmed);
          const std::string lowered = ToLowerCopy(trimmed);
          if (lowered == "true" || lowered == "yes" || lowered == "on") {
            options.setNumeric(key, 1.0);
          } else if (lowered == "false" || lowered == "no" || lowered == "off") {
            options.setNumeric(key, 0.0);
          } else {
            try {
              const double parsed = std::stod(trimmed);
              options.setNumeric(key, parsed);
            } catch (const std::exception&) {
              // keep as string only
            }
          }
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

daft::audio::InstrumentEvent MakeMidiEvent(std::uint64_t frame, jint type,
                                           jint channel, jint data1, jint data2) {
  using daft::audio::InstrumentEvent;
  using daft::audio::InstrumentEventType;
  if (type < 0 || type > static_cast<jint>(InstrumentEventType::kPolyAftertouch) ||
      channel < 0 || channel > 15 || data1 < 0 || data1 > 127 || data2 < 0 ||
      data2 > 127) {
    throw std::invalid_argument("Invalid MIDI event fields");
  }

  InstrumentEvent event{};
  event.frame = frame;
  event.type = static_cast<InstrumentEventType>(type);
  event.channel = static_cast<std::uint8_t>(channel);
  switch (event.type) {
    case InstrumentEventType::kNoteOn:
    case InstrumentEventType::kNoteOff:
    case InstrumentEventType::kControlChange:
    case InstrumentEventType::kPolyAftertouch:
      event.data = static_cast<std::uint8_t>(data1);
      event.value = static_cast<float>(data2) / 127.0F;
      break;
    case InstrumentEventType::kPitchBend: {
      const int encoded = (data2 << 7) | data1;
      event.value = static_cast<float>(encoded - 8192) / 8192.0F;
      break;
    }
    case InstrumentEventType::kChannelAftertouch:
      event.value = static_cast<float>(data1) / 127.0F;
      break;
    case InstrumentEventType::kParameter:
    case InstrumentEventType::kAllNotesOff:
      throw std::invalid_argument("Unsupported MIDI event type");
  }
  return event;
}

void RequireMatchingArrayLength(JNIEnv* env, jsize expected, jarray array,
                                const char* field) {
  if (array == nullptr || env->GetArrayLength(array) != expected) {
    throw std::invalid_argument(std::string(field) + " length must match frames");
  }
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

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeUnregisterClipBuffer(JNIEnv* env, jobject /*thiz*/, jstring bufferKey) {
  if (bufferKey == nullptr) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "bufferKey is required");
    return;
  }
  const std::string key = ToStdString(env, bufferKey);
  if (key.empty()) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "bufferKey is required");
    return;
  }
  if (!AudioEngineBridge::unregisterClipBuffer(key)) {
    ThrowJavaException(env, "java/lang/IllegalStateException", "Failed to unregister clip buffer '" + key + "'");
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

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeSendMidiEvent(
    JNIEnv* env, jobject /*thiz*/, jstring nodeId, jint type, jint channel,
    jint data1, jint data2, jlong frameOffset) {
  if (frameOffset < 0) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException",
                       "frameOffset must be non-negative");
    return;
  }
  try {
    auto event = MakeMidiEvent(0U, type, channel, data1, data2);
    AudioEngineBridge::scheduleInstrumentEventFromNow(
        ToStdString(env, nodeId), event, static_cast<std::uint64_t>(frameOffset));
  } catch (const std::invalid_argument& ex) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", ex.what());
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeSendMidiEvents(
    JNIEnv* env, jobject /*thiz*/, jstring nodeId, jlongArray frames,
    jintArray types, jintArray channels, jintArray data1, jintArray data2,
    jboolean replace) {
  try {
    if (frames == nullptr) {
      throw std::invalid_argument("frames are required");
    }
    const jsize count = env->GetArrayLength(frames);
    RequireMatchingArrayLength(env, count, types, "types");
    RequireMatchingArrayLength(env, count, channels, "channels");
    RequireMatchingArrayLength(env, count, data1, "data1");
    RequireMatchingArrayLength(env, count, data2, "data2");

    std::vector<jlong> nativeFrames(static_cast<std::size_t>(count));
    std::vector<jint> nativeTypes(static_cast<std::size_t>(count));
    std::vector<jint> nativeChannels(static_cast<std::size_t>(count));
    std::vector<jint> nativeData1(static_cast<std::size_t>(count));
    std::vector<jint> nativeData2(static_cast<std::size_t>(count));
    env->GetLongArrayRegion(frames, 0, count, nativeFrames.data());
    env->GetIntArrayRegion(types, 0, count, nativeTypes.data());
    env->GetIntArrayRegion(channels, 0, count, nativeChannels.data());
    env->GetIntArrayRegion(data1, 0, count, nativeData1.data());
    env->GetIntArrayRegion(data2, 0, count, nativeData2.data());
    if (env->ExceptionCheck() == JNI_TRUE) {
      return;
    }

    std::vector<daft::audio::InstrumentEvent> events;
    events.reserve(static_cast<std::size_t>(count));
    for (jsize index = 0; index < count; ++index) {
      if (nativeFrames[static_cast<std::size_t>(index)] < 0) {
        throw std::invalid_argument("MIDI event frame must be non-negative");
      }
      events.push_back(MakeMidiEvent(
          static_cast<std::uint64_t>(nativeFrames[static_cast<std::size_t>(index)]),
          nativeTypes[static_cast<std::size_t>(index)],
          nativeChannels[static_cast<std::size_t>(index)],
          nativeData1[static_cast<std::size_t>(index)],
          nativeData2[static_cast<std::size_t>(index)]));
    }
    AudioEngineBridge::scheduleInstrumentEvents(ToStdString(env, nodeId), events,
                                                 replace == JNI_TRUE);
  } catch (const std::invalid_argument& ex) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", ex.what());
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeSetInstrumentParameter(
    JNIEnv* env, jobject /*thiz*/, jstring nodeId, jint parameterId,
    jdouble value, jlong frameOffset) {
  if (parameterId <= 0 || parameterId > 65535 || !std::isfinite(value) ||
      frameOffset < 0) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException",
                       "Invalid instrument parameter event");
    return;
  }
  try {
    const daft::audio::InstrumentEvent event{
        0U, daft::audio::InstrumentEventType::kParameter,
        static_cast<std::uint16_t>(parameterId), 0U, 0U,
        static_cast<float>(value)};
    AudioEngineBridge::scheduleInstrumentEventFromNow(
        ToStdString(env, nodeId), event, static_cast<std::uint64_t>(frameOffset));
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeSendInstrumentParameters(
    JNIEnv* env, jobject /*thiz*/, jstring nodeId, jlongArray frames,
    jintArray parameterIds, jdoubleArray values, jboolean replace) {
  try {
    if (frames == nullptr) {
      throw std::invalid_argument("frames are required");
    }
    const jsize count = env->GetArrayLength(frames);
    RequireMatchingArrayLength(env, count, parameterIds, "parameterIds");
    RequireMatchingArrayLength(env, count, values, "values");

    std::vector<jlong> nativeFrames(static_cast<std::size_t>(count));
    std::vector<jint> nativeParameterIds(static_cast<std::size_t>(count));
    std::vector<jdouble> nativeValues(static_cast<std::size_t>(count));
    env->GetLongArrayRegion(frames, 0, count, nativeFrames.data());
    env->GetIntArrayRegion(parameterIds, 0, count, nativeParameterIds.data());
    env->GetDoubleArrayRegion(values, 0, count, nativeValues.data());
    if (env->ExceptionCheck() == JNI_TRUE) {
      return;
    }

    std::vector<daft::audio::InstrumentEvent> events;
    events.reserve(static_cast<std::size_t>(count));
    for (jsize index = 0; index < count; ++index) {
      const auto offset = static_cast<std::size_t>(index);
      if (nativeFrames[offset] < 0 || nativeParameterIds[offset] <= 0 ||
          nativeParameterIds[offset] > 65535 || !std::isfinite(nativeValues[offset])) {
        throw std::invalid_argument("Invalid instrument parameter event");
      }
      events.push_back({
          static_cast<std::uint64_t>(nativeFrames[offset]),
          daft::audio::InstrumentEventType::kParameter,
          static_cast<std::uint16_t>(nativeParameterIds[offset]), 0U, 0U,
          static_cast<float>(nativeValues[offset])});
    }
    AudioEngineBridge::scheduleInstrumentEvents(ToStdString(env, nodeId), events,
                                                 replace == JNI_TRUE);
  } catch (const std::invalid_argument& ex) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", ex.what());
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeAllNotesOff(
    JNIEnv* env, jobject /*thiz*/, jstring nodeId) {
  try {
    AudioEngineBridge::allNotesOff(ToStdString(env, nodeId));
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeStartTransport(JNIEnv* env, jobject /*thiz*/) {
  try {
    AudioEngineBridge::startTransport();
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeStopTransport(JNIEnv* env, jobject /*thiz*/) {
  try {
    AudioEngineBridge::stopTransport();
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeLocateTransport(JNIEnv* env, jobject /*thiz*/, jlong frame) {
  if (frame < 0) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "frame must be non-negative");
    return;
  }
  try {
    AudioEngineBridge::locateTransport(static_cast<std::uint64_t>(frame));
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeSetTransportLoop(
    JNIEnv* env, jobject /*thiz*/, jlong startFrame, jlong endFrame,
    jboolean enabled) {
  if (startFrame < 0 || endFrame < 0 ||
      (enabled == JNI_TRUE && startFrame >= endFrame)) {
    ThrowJavaException(
        env, "java/lang/IllegalArgumentException",
        "Enabled transport loop requires non-negative frames and startFrame < endFrame");
    return;
  }
  try {
    AudioEngineBridge::setTransportLoop(
        static_cast<std::uint64_t>(startFrame),
        static_cast<std::uint64_t>(endFrame), enabled == JNI_TRUE);
  } catch (const std::invalid_argument& ex) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", ex.what());
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT jdoubleArray JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeGetTransportState(JNIEnv* env, jobject /*thiz*/) {
  const auto state = AudioEngineBridge::getTransportState();
  jdoubleArray result = env->NewDoubleArray(2);
  if (result == nullptr) {
    return nullptr;
  }
  const jdouble payload[2] = {
      static_cast<jdouble>(state.currentFrame),
      state.isPlaying ? 1.0 : 0.0,
  };
  env->SetDoubleArrayRegion(result, 0, 2, payload);
  return result;
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeRenderInterleaved(JNIEnv* env, jobject /*thiz*/,
                                                                     jfloatArray output, jint channels,
                                                                     jint frames) {
  if (output == nullptr || channels <= 0 || frames <= 0 ||
      static_cast<std::size_t>(channels) > daft::audio::SceneGraph::maxSupportedChannels() ||
      static_cast<std::size_t>(frames) > daft::audio::SceneGraph::maxSupportedFramesPerBuffer()) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "Invalid render buffer dimensions");
    return;
  }
  const auto requiredSamples = static_cast<jsize>(channels * frames);
  if (env->GetArrayLength(output) < requiredSamples) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "Render buffer is too small");
    return;
  }

  using PlanarBuffer = std::array<
      std::array<float, daft::audio::SceneGraph::maxSupportedFramesPerBuffer()>,
      daft::audio::SceneGraph::maxSupportedChannels()>;
  thread_local PlanarBuffer planar{};
  std::array<float*, daft::audio::SceneGraph::maxSupportedChannels()> channelPointers{};
  for (jint channel = 0; channel < channels; ++channel) {
    channelPointers[static_cast<std::size_t>(channel)] = planar[static_cast<std::size_t>(channel)].data();
  }
  AudioEngineBridge::render(channelPointers.data(), static_cast<std::size_t>(channels),
                            static_cast<std::size_t>(frames));

  jboolean isCopy = JNI_FALSE;
  jfloat* interleaved = env->GetFloatArrayElements(output, &isCopy);
  if (interleaved == nullptr) {
    return;
  }
  for (jint frame = 0; frame < frames; ++frame) {
    for (jint channel = 0; channel < channels; ++channel) {
      interleaved[frame * channels + channel] =
          planar[static_cast<std::size_t>(channel)][static_cast<std::size_t>(frame)];
    }
  }
  env->ReleaseFloatArrayElements(output, interleaved, 0);
}

/**
 * @brief Retrieve runtime diagnostics from the audio engine.
 *
 * @return jdoubleArray A 3-element double array where element 0 is the number of xruns,
 * element 1 is the last render duration in microseconds, and element 2 is the total
 * number of bytes retained by registered clip buffers. Returns `nullptr` if allocation fails.
 */
JNIEXPORT jdoubleArray JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeGetDiagnostics(JNIEnv* env, jobject /*thiz*/) {
  jdoubleArray result = env->NewDoubleArray(3);
  if (result == nullptr) {
    return nullptr;
  }
  const auto diagnostics = AudioEngineBridge::getDiagnostics();
  const jdouble payload[3] = {
      static_cast<jdouble>(diagnostics.xruns),
      diagnostics.lastRenderDurationMicros,
      static_cast<jdouble>(diagnostics.clipBufferBytes),
  };
  env->SetDoubleArrayRegion(result, 0, 3, payload);
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
