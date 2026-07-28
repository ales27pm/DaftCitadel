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
using daft::audio::GraphApplyRequest;
using daft::audio::GraphApplyResult;
using daft::audio::GraphApplyStatus;
using daft::audio::GraphApplyStatusName;
using daft::audio::GraphConnectionDefinition;
using daft::audio::GraphDescription;
using daft::audio::GraphErrorCodeName;
using daft::audio::GraphFailureStageName;
using daft::audio::PreparedGraphNode;

namespace {

constexpr std::size_t kOutputChannelCount = 2U;
std::vector<float> gRenderScratch;
std::size_t gRenderFrameCapacity = 0U;

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

void AppendGraphDescription(const GraphDescription& description,
                            std::vector<std::string>& payload) {
  payload.push_back(std::to_string(description.generation));
  payload.push_back(description.graphHash);
  payload.push_back(std::to_string(description.routeEpoch));
  payload.push_back(std::to_string(description.engineInstance));
  payload.push_back(std::to_string(description.nodeIds.size()));
  payload.insert(payload.end(), description.nodeIds.begin(),
                 description.nodeIds.end());
}

jobjectArray ToJavaStringArray(
    JNIEnv* env, const std::vector<std::string>& values) {
  jclass stringClass = env->FindClass("java/lang/String");
  if (stringClass == nullptr) {
    return nullptr;
  }
  jobjectArray result = env->NewObjectArray(
      static_cast<jsize>(values.size()), stringClass, nullptr);
  env->DeleteLocalRef(stringClass);
  if (result == nullptr) {
    return nullptr;
  }
  for (jsize index = 0;
       index < static_cast<jsize>(values.size()); ++index) {
    jstring value =
        env->NewStringUTF(values[static_cast<std::size_t>(index)].c_str());
    if (value == nullptr) {
      return nullptr;
    }
    env->SetObjectArrayElement(result, index, value);
    env->DeleteLocalRef(value);
  }
  return result;
}

jobjectArray EncodeGraphDescription(
    JNIEnv* env, const GraphDescription& description) {
  std::vector<std::string> payload;
  payload.reserve(5U + description.nodeIds.size());
  AppendGraphDescription(description, payload);
  return ToJavaStringArray(env, payload);
}

jobjectArray EncodeGraphApplyResult(
    JNIEnv* env, const GraphApplyResult& result) {
  std::vector<std::string> payload;
  payload.reserve(11U + result.graph.nodeIds.size());
  payload.push_back(GraphApplyStatusName(result.status));
  payload.push_back(result.transactionId);
  AppendGraphDescription(result.graph, payload);
  if (result.failure.has_value()) {
    payload.push_back(GraphFailureStageName(result.failure->stage));
    payload.push_back(GraphErrorCodeName(result.failure->code));
    payload.push_back(result.failure->nodeId);
    payload.push_back(result.failure->detail);
  } else {
    payload.insert(payload.end(), 4U, std::string());
  }
  return ToJavaStringArray(env, payload);
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
    std::vector<float> preparedRenderScratch(
        static_cast<std::size_t>(framesPerBuffer) * kOutputChannelCount);
    AudioEngineBridge::initialize(env, sampleRate, static_cast<std::uint32_t>(framesPerBuffer));
    const auto graphInitialization =
        AudioEngineBridge::initializeGraphTransactions(
            sampleRate, static_cast<std::uint32_t>(framesPerBuffer));
    if (graphInitialization.status != GraphApplyStatus::Committed) {
      const std::string detail =
          graphInitialization.failure.has_value()
              ? graphInitialization.failure->detail
              : "Native graph transaction initialization failed";
      AudioEngineBridge::shutdown();
      throw std::runtime_error(detail);
    }
    gRenderScratch = std::move(preparedRenderScratch);
    gRenderFrameCapacity = static_cast<std::size_t>(framesPerBuffer);
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
    (void)AudioEngineBridge::invalidateGraphTransactions();
    AudioEngineBridge::shutdown();
    gRenderScratch.clear();
    gRenderFrameCapacity = 0U;
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/RuntimeException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeRenderInterleaved(
    JNIEnv* env, jobject /*thiz*/, jfloatArray output, jint channelCount,
    jint frameCount) {
  if (output == nullptr) {
    return;
  }
  const auto outputLength =
      static_cast<std::size_t>(env->GetArrayLength(output));
  auto* interleaved =
      static_cast<jfloat*>(env->GetPrimitiveArrayCritical(output, nullptr));
  if (interleaved == nullptr) {
    return;
  }

  const bool valid =
      channelCount > 0 &&
      static_cast<std::size_t>(channelCount) <= kOutputChannelCount &&
      frameCount > 0 &&
      static_cast<std::size_t>(frameCount) <= gRenderFrameCapacity &&
      outputLength >=
          static_cast<std::size_t>(channelCount) *
              static_cast<std::size_t>(frameCount);
  if (!valid) {
    std::fill(interleaved, interleaved + outputLength, 0.0F);
    env->ReleasePrimitiveArrayCritical(output, interleaved, 0);
    return;
  }

  const auto channels = static_cast<std::size_t>(channelCount);
  const auto frames = static_cast<std::size_t>(frameCount);
  std::fill(gRenderScratch.begin(), gRenderScratch.end(), 0.0F);
  std::array<float*, kOutputChannelCount> planar{
      gRenderScratch.data(),
      gRenderScratch.data() + gRenderFrameCapacity,
  };
  AudioEngineBridge::render(planar.data(), channels, frames);
  for (std::size_t frame = 0; frame < frames; ++frame) {
    for (std::size_t channel = 0; channel < channels; ++channel) {
      interleaved[frame * channels + channel] =
          planar[channel][frame];
    }
  }
  env->ReleasePrimitiveArrayCritical(output, interleaved, 0);
}

JNIEXPORT jobjectArray JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeRecoverAfterAudioConfigurationChange(
    JNIEnv* env, jobject /*thiz*/) {
  try {
    const auto transport = AudioEngineBridge::getTransportState();
    AudioEngineBridge::stopTransport();
    const auto recovery =
        AudioEngineBridge::recoverAfterAudioConfigurationChange();
    if (recovery.status == GraphApplyStatus::Committed &&
        transport.isPlaying) {
      AudioEngineBridge::locateTransport(transport.currentFrame);
      AudioEngineBridge::startTransport();
    }
    return EncodeGraphApplyResult(env, recovery);
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
    return nullptr;
  }
}

JNIEXPORT jobjectArray JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeDescribeGraph(
    JNIEnv* env, jobject /*thiz*/) {
  try {
    return EncodeGraphDescription(env, AudioEngineBridge::describeGraph());
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
    return nullptr;
  }
}

JNIEXPORT jobjectArray JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeApplyGraph(
    JNIEnv* env, jobject /*thiz*/, jstring transactionId,
    jlong expectedGeneration, jlong expectedRouteEpoch,
    jlong expectedEngineInstance, jobjectArray nodeIds,
    jobjectArray nodeTypes, jobjectArray nodeOptions,
    jobjectArray optionFingerprints, jobjectArray connectionSources,
    jobjectArray connectionDestinations) {
  if (transactionId == nullptr || nodeIds == nullptr ||
      nodeTypes == nullptr || nodeOptions == nullptr ||
      optionFingerprints == nullptr || connectionSources == nullptr ||
      connectionDestinations == nullptr ||
      expectedGeneration < 0 || expectedRouteEpoch < 0 ||
      expectedEngineInstance < 0) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException",
                       "Graph transaction payload is invalid");
    return nullptr;
  }

  const jsize nodeCount = env->GetArrayLength(nodeIds);
  if (env->GetArrayLength(nodeTypes) != nodeCount ||
      env->GetArrayLength(nodeOptions) != nodeCount ||
      env->GetArrayLength(optionFingerprints) != nodeCount) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException",
                       "Graph node arrays must have matching lengths");
    return nullptr;
  }
  const jsize connectionCount =
      env->GetArrayLength(connectionSources);
  if (env->GetArrayLength(connectionDestinations) != connectionCount) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException",
                       "Graph connection arrays must have matching lengths");
    return nullptr;
  }

  try {
    GraphApplyRequest request;
    request.transactionId = ToStdString(env, transactionId);
    if (request.transactionId.empty()) {
      throw std::invalid_argument("transactionId is required");
    }
    request.expectedGeneration =
        static_cast<std::uint64_t>(expectedGeneration);
    request.expectedRouteEpoch =
        static_cast<std::uint64_t>(expectedRouteEpoch);
    request.expectedEngineInstance =
        static_cast<std::uint64_t>(expectedEngineInstance);
    request.nodes.reserve(static_cast<std::size_t>(nodeCount));

    for (jsize index = 0; index < nodeCount; ++index) {
      jstring nodeId = static_cast<jstring>(
          env->GetObjectArrayElement(nodeIds, index));
      jstring nodeType = static_cast<jstring>(
          env->GetObjectArrayElement(nodeTypes, index));
      jobject optionsMap =
          env->GetObjectArrayElement(nodeOptions, index);
      jstring fingerprint = static_cast<jstring>(
          env->GetObjectArrayElement(optionFingerprints, index));

      PreparedGraphNode prepared;
      prepared.id = ToStdString(env, nodeId);
      prepared.type = ToStdString(env, nodeType);
      prepared.optionsFingerprint =
          ToStdString(env, fingerprint);
      NodeOptions options = ConvertOptions(env, optionsMap);
      std::string error;
      prepared.node = CreateNode(prepared.type, options, error);

      env->DeleteLocalRef(nodeId);
      env->DeleteLocalRef(nodeType);
      env->DeleteLocalRef(optionsMap);
      env->DeleteLocalRef(fingerprint);

      if (!prepared.node) {
        throw std::invalid_argument(error);
      }
      request.nodes.push_back(std::move(prepared));
    }

    request.connections.reserve(
        static_cast<std::size_t>(connectionCount));
    for (jsize index = 0; index < connectionCount; ++index) {
      jstring source = static_cast<jstring>(
          env->GetObjectArrayElement(connectionSources, index));
      jstring destination = static_cast<jstring>(
          env->GetObjectArrayElement(connectionDestinations, index));
      GraphConnectionDefinition connection;
      connection.source = ToStdString(env, source);
      connection.destination = ToStdString(env, destination);
      env->DeleteLocalRef(source);
      env->DeleteLocalRef(destination);
      request.connections.push_back(std::move(connection));
    }

    return EncodeGraphApplyResult(
        env, AudioEngineBridge::applyGraph(std::move(request)));
  } catch (const std::invalid_argument& ex) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", ex.what());
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
  return nullptr;
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
Java_com_daftcitadel_audio_AudioEngineModule_nativeSetTransportLoop(JNIEnv* env, jobject /*thiz*/, jlong startFrame,
                                                                    jlong endFrame, jboolean enabled) {
  if (startFrame < 0 || endFrame < 0) {
    ThrowJavaException(env, "java/lang/IllegalArgumentException", "transport loop frames must be non-negative");
    return;
  }
  try {
    AudioEngineBridge::setTransportLoop(static_cast<std::uint64_t>(startFrame),
                                        static_cast<std::uint64_t>(endFrame),
                                        enabled == JNI_TRUE);
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

JNIEXPORT jdoubleArray JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeGetTransportState(JNIEnv* env, jobject /*thiz*/) {
  constexpr jsize kPayloadSize = 2;
  jdoubleArray result = env->NewDoubleArray(kPayloadSize);
  if (result == nullptr) {
    return nullptr;
  }
  try {
    const auto state = AudioEngineBridge::getTransportState();
    const jdouble payload[kPayloadSize] = {
        static_cast<jdouble>(state.currentFrame),
        state.isPlaying ? 1.0 : 0.0,
    };
    env->SetDoubleArrayRegion(result, 0, kPayloadSize, payload);
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
  return result;
}

/**
 * @brief Retrieve runtime diagnostics from the audio engine.
 *
 * @return jdoubleArray containing render diagnostics with the following entries:
 *   0 — number of xruns,
 *   1 — last render duration in microseconds,
 *   2 — total bytes retained by registered clip buffers,
 *   3 — activeVoices,
 *   4 — pendingInstrumentEvents,
 *   5 — realtimeQueueDepth,
 *   6 — realtimeQueueOverflows,
 *   7 — realtimeCommandFailures,
 *   8 — renderCount,
 *   9 — averageRenderDurationMicros,
 *   10 — maximumRenderDurationMicros,
 *   11 — p50RenderDurationMicros,
 *   12 — p95RenderDurationMicros,
 *   13 — p99RenderDurationMicros.
 * Returns `nullptr` if allocation fails.
 */
JNIEXPORT jdoubleArray JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeGetDiagnostics(JNIEnv* env, jobject /*thiz*/) {
  constexpr jsize kPayloadSize = 14;
  jdoubleArray result = env->NewDoubleArray(kPayloadSize);
  if (result == nullptr) {
    return nullptr;
  }
  const auto diagnostics = AudioEngineBridge::getDiagnostics();
  const jdouble payload[kPayloadSize] = {
      static_cast<jdouble>(diagnostics.xruns),
      diagnostics.lastRenderDurationMicros,
      static_cast<jdouble>(diagnostics.clipBufferBytes),
      static_cast<jdouble>(diagnostics.activeVoices),
      static_cast<jdouble>(diagnostics.pendingInstrumentEvents),
      static_cast<jdouble>(diagnostics.realtimeQueueDepth),
      static_cast<jdouble>(diagnostics.realtimeQueueOverflows),
      static_cast<jdouble>(diagnostics.realtimeCommandFailures),
      static_cast<jdouble>(diagnostics.renderCount),
      diagnostics.averageRenderDurationMicros,
      diagnostics.maximumRenderDurationMicros,
      diagnostics.p50RenderDurationMicros,
      diagnostics.p95RenderDurationMicros,
      diagnostics.p99RenderDurationMicros,
  };
  env->SetDoubleArrayRegion(result, 0, kPayloadSize, payload);
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
