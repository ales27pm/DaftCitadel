#pragma once

#include <array>
#include <atomic>
#include <mutex>
#include <string>
#include <unordered_map>

class RCUParameterManager {
 public:
  struct ParamChange {
    std::string id;
    float value = 0.0f;
  };

  void set(const std::string& id, float value);
  float get(const std::string& id, float defaultValue = 0.0f) const;
  bool tryPop(ParamChange& change);
  void clear();

 private:
  static constexpr std::size_t kQueueCapacity = 128;
  std::array<ParamChange, kQueueCapacity> queue_{};
  std::atomic<std::size_t> head_{0};
  std::atomic<std::size_t> tail_{0};
  bool push(const ParamChange& change);

  mutable std::mutex mutex_;
  std::unordered_map<std::string, float> params_;
};

