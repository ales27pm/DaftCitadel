#pragma once

#include "audio_engine/SceneGraph.h"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace daft::audio {

enum class GraphFailureStage {
  None,
  Validate,
  Allocate,
  Prepare,
  Connect,
  Commit,
  Lifecycle,
  Route,
};

enum class GraphErrorCode {
  None,
  InvalidRequest,
  DuplicateNode,
  MissingEndpoint,
  ResourceAllocationFailed,
  NodePreparationFailed,
  ConnectionRejected,
  CommitRejected,
  StaleGeneration,
  StaleRouteEpoch,
  StaleEngineInstance,
  EngineUnavailable,
  EngineInvalidated,
  AudioConfigurationChanged,
};

enum class GraphApplyStatus {
  Committed,
  Stale,
  Rejected,
};

const char* GraphFailureStageName(GraphFailureStage stage) noexcept;
const char* GraphErrorCodeName(GraphErrorCode code) noexcept;
const char* GraphApplyStatusName(GraphApplyStatus status) noexcept;

struct GraphFailure {
  GraphFailureStage stage{GraphFailureStage::None};
  GraphErrorCode code{GraphErrorCode::None};
  std::string nodeId;
  std::string detail;
};

struct PreparedGraphNode {
  std::string id;
  std::string type;
  std::string optionsFingerprint;
  std::unique_ptr<DSPNode> node;
};

struct GraphConnectionDefinition {
  std::string source;
  std::string destination;
};

struct GraphDescription {
  std::uint64_t generation{0};
  std::string graphHash;
  std::vector<std::string> nodeIds;
  std::uint64_t routeEpoch{0};
  std::uint64_t engineInstance{0};
};

struct GraphApplyResult {
  GraphApplyStatus status{GraphApplyStatus::Rejected};
  std::string transactionId;
  GraphDescription graph;
  std::optional<GraphFailure> failure;
};

// RenderPlan is prepared entirely on the control path. Once published, its
// SceneGraph and identity are immutable until the whole plan is replaced.
class RenderPlan final {
 public:
  static std::unique_ptr<RenderPlan> Prepare(
      double sampleRate,
      std::size_t maxFramesPerBlock,
      std::uint64_t generation,
      std::vector<PreparedGraphNode> nodes,
      std::vector<GraphConnectionDefinition> connections,
      GraphFailure* failure = nullptr,
      GraphFailureStage injectedFailure = GraphFailureStage::None);

  RenderPlan(const RenderPlan&) = delete;
  RenderPlan& operator=(const RenderPlan&) = delete;
  RenderPlan(RenderPlan&&) = delete;
  RenderPlan& operator=(RenderPlan&&) = delete;
  ~RenderPlan() = default;

  SceneGraph& graph() noexcept { return graph_; }
  const SceneGraph& graph() const noexcept { return graph_; }

  std::uint64_t generation() const noexcept { return generation_; }
  const std::string& graphHash() const noexcept { return graphHash_; }
  const std::vector<std::string>& nodeIds() const noexcept { return nodeIds_; }
  bool shouldInjectCommitFailure() const noexcept {
    return injectCommitFailure_;
  }

 private:
  RenderPlan(double sampleRate,
             std::size_t maxFramesPerBlock,
             std::uint64_t generation,
             std::string graphHash,
             std::vector<std::string> nodeIds,
             bool injectCommitFailure);

  SceneGraph graph_;
  const std::uint64_t generation_;
  const std::string graphHash_;
  const std::vector<std::string> nodeIds_;
  const bool injectCommitFailure_;
};

}  // namespace daft::audio
