#include "audio_engine/instruments/juno/RCUParameterManager.hpp"

void RCUParameterManager::set(const std::string& id, float value) {
  std::lock_guard<std::mutex> lock(mutex_);
  params_[id] = value;
  push({id, value});
}

float RCUParameterManager::get(const std::string& id, float defaultValue) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = params_.find(id);
  return it != params_.end() ? it->second : defaultValue;
}

bool RCUParameterManager::push(const ParamChange& change) {
  const std::size_t currentHead = head_.load(std::memory_order_relaxed);
  const std::size_t nextHead = (currentHead + 1) % kQueueCapacity;
  const std::size_t tailSnapshot = tail_.load(std::memory_order_acquire);
  if (nextHead == tailSnapshot) {
    tail_.store((tailSnapshot + 1) % kQueueCapacity, std::memory_order_release);
  }
  queue_[currentHead] = change;
  head_.store(nextHead, std::memory_order_release);
  return true;
}

bool RCUParameterManager::tryPop(ParamChange& change) {
  const std::size_t currentTail = tail_.load(std::memory_order_relaxed);
  const std::size_t headSnapshot = head_.load(std::memory_order_acquire);
  if (currentTail == headSnapshot) {
    return false;
  }
  change = queue_[currentTail];
  const std::size_t nextTail = (currentTail + 1) % kQueueCapacity;
  tail_.store(nextTail, std::memory_order_release);
  return true;
}

void RCUParameterManager::clear() {
  head_.store(0, std::memory_order_release);
  tail_.store(0, std::memory_order_release);
  std::lock_guard<std::mutex> lock(mutex_);
  params_.clear();
}

