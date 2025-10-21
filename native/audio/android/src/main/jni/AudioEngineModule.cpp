#include <jni.h>

#include <algorithm>
#include <cctype>
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

std::string NormalizeKey(const std::string& key) {
  std::string normalized = key;
  std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return normalized;
}

void ThrowJavaException(JNIEnv* env, const char* className, const std::string& message) {
  jclass exceptionClass = env->FindClass(className);
  if (exceptionClass == nullptr) {
    return;
  }
  env->ThrowNew(exceptionClass, message.c_str());
  env->DeleteLocalRef(exceptionClass);
}

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

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeInitialize(JNIEnv* env, jobject /*thiz*/, jdouble sampleRate,
                                                             jint framesPerBuffer) {
  try {
    AudioEngineBridge::initialize(env, sampleRate, static_cast<std::uint32_t>(framesPerBuffer));
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/RuntimeException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeShutdown(JNIEnv* env, jobject /*thiz*/) {
  try {
    AudioEngineBridge::shutdown();
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/RuntimeException", ex.what());
  }
}

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
Java_com_daftcitadel_audio_AudioEngineModule_nativeRemoveNode(JNIEnv* env, jobject /*thiz*/, jstring nodeId) {
  try {
    AudioEngineBridge::removeNode(ToStdString(env, nodeId));
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/RuntimeException", ex.what());
  }
}

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

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeDisconnectNodes(JNIEnv* env, jobject /*thiz*/, jstring source,
                                                                   jstring destination) {
  try {
    AudioEngineBridge::disconnect(ToStdString(env, source), ToStdString(env, destination));
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/RuntimeException", ex.what());
  }
}

JNIEXPORT void JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeScheduleAutomation(JNIEnv* env, jobject /*thiz*/, jstring nodeId,
                                                                      jstring parameter, jlong frame, jdouble value) {
  try {
    AudioEngineBridge::scheduleParameterAutomation(ToStdString(env, nodeId), ToStdString(env, parameter),
                                                   static_cast<std::uint64_t>(frame), value);
  } catch (const std::exception& ex) {
    ThrowJavaException(env, "java/lang/IllegalStateException", ex.what());
  }
}

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

JNIEXPORT jint JNICALL
Java_com_daftcitadel_audio_AudioEngineModule_nativeMaxFramesPerBuffer(JNIEnv*, jobject /*thiz*/) {
  return static_cast<jint>(daft::audio::SceneGraph::maxSupportedFramesPerBuffer());
}

}  // extern "C"
