#pragma once

#include "audio_engine/RenderPlan.h"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace daft::audio {

struct GraphApplyRequest {
  std::string transactionId;
  std::uint64_t expectedGeneration{0};
  std::uint64_t expectedRouteEpoch{0};
  std::uint64_t expectedEngineInstance{0};
  std::vector<PreparedGraphNode> nodes;
  std::vector<GraphConnectionDefinition> connections;
  GraphFailureStage injectedFailure{GraphFailureStage::None};
};

// Owns the complete graph lifecycle on the control path. The publish callback
// performs the single pointer publication consumed by the render callback; the
// quiesce callback proves that retired plans can be destroyed safely.
class GraphTransactionHost final {
 public:
  using PublishCallback =
      std::function<bool(SceneGraph* graph, std::uint64_t engineInstance)>;
  using QuiesceCallback = std::function<void()>;

  GraphTransactionHost(double sampleRate,
                       std::size_t maxFramesPerBlock,
                       PublishCallback publish,
                       QuiesceCallback quiesce);

  GraphTransactionHost(const GraphTransactionHost&) = delete;
  GraphTransactionHost& operator=(const GraphTransactionHost&) = delete;

  GraphApplyResult initialize(std::uint64_t engineInstance);
  GraphDescription describeGraph() const;
  GraphApplyResult applyGraph(GraphApplyRequest request);
  GraphApplyResult recoverAudioConfiguration(
      std::uint64_t expectedEngineInstance,
      std::string transactionId = "audio-configuration-recovery");

  // A stale module owner cannot invalidate a newer engine instance.
  bool invalidate(std::uint64_t expectedEngineInstance);
  bool isInitialized() const;

 private:
  GraphDescription describeGraphLocked() const;
  GraphApplyResult resultLocked(
      GraphApplyStatus status,
      std::string transactionId,
      std::optional<GraphFailure> failure = std::nullopt) const;
  GraphApplyResult staleLocked(std::string transactionId,
                               GraphErrorCode code,
                               GraphFailureStage stage,
                               std::string detail) const;
  GraphApplyResult rejectedLocked(std::string transactionId,
                                  GraphErrorCode code,
                                  GraphFailureStage stage,
                                  std::string detail) const;
  bool publishLocked(SceneGraph* graph, std::uint64_t engineInstance);
  void retireAndQuiesceLocked(std::unique_ptr<RenderPlan> retired);

  const double sampleRate_;
  const std::size_t maxFramesPerBlock_;
  const PublishCallback publish_;
  const QuiesceCallback quiesce_;

  mutable std::mutex mutex_;
  std::unique_ptr<RenderPlan> activePlan_;
  std::vector<std::unique_ptr<RenderPlan>> retiredPlans_;
  std::uint64_t routeEpoch_{0};
  std::uint64_t engineInstance_{0};
  bool initialized_{false};
  bool wasInvalidated_{false};
  std::optional<GraphApplyResult> lastApplyResult_;
};

}  // namespace daft::audio
