#include "audio_engine/GraphTransactionHost.h"

#include <exception>
#include <utility>

namespace daft::audio {
namespace {

GraphFailure MakeFailure(GraphFailureStage stage,
                         GraphErrorCode code,
                         std::string detail) {
  GraphFailure failure;
  failure.stage = stage;
  failure.code = code;
  failure.detail = std::move(detail);
  return failure;
}

}  // namespace

GraphTransactionHost::GraphTransactionHost(
    double sampleRate,
    std::size_t maxFramesPerBlock,
    PublishCallback publish,
    QuiesceCallback quiesce)
    : sampleRate_(sampleRate),
      maxFramesPerBlock_(maxFramesPerBlock),
      publish_(std::move(publish)),
      quiesce_(std::move(quiesce)) {}

GraphApplyResult GraphTransactionHost::initialize(
    std::uint64_t engineInstance) {
  std::lock_guard<std::mutex> lock(mutex_);

  if (engineInstance == 0) {
    return rejectedLocked("initialize", GraphErrorCode::InvalidRequest,
                          GraphFailureStage::Lifecycle,
                          "Engine instance must be non-zero");
  }

  if (initialized_ && engineInstance_ == engineInstance) {
    return resultLocked(GraphApplyStatus::Committed, "initialize");
  }

  GraphFailure failure;
  auto plan = RenderPlan::Prepare(sampleRate_, maxFramesPerBlock_, 0, {}, {},
                                  &failure);
  if (plan == nullptr) {
    return resultLocked(GraphApplyStatus::Rejected, "initialize",
                        std::move(failure));
  }

  if (!publishLocked(&plan->graph(), engineInstance)) {
    return rejectedLocked("initialize", GraphErrorCode::CommitRejected,
                          GraphFailureStage::Commit,
                          "Unable to publish the initial render plan");
  }

  auto retired = std::move(activePlan_);
  activePlan_ = std::move(plan);
  engineInstance_ = engineInstance;
  routeEpoch_ = routeEpoch_ == 0 ? 1 : routeEpoch_ + 1;
  initialized_ = true;
  wasInvalidated_ = false;
  lastApplyResult_.reset();
  retireAndQuiesceLocked(std::move(retired));
  return resultLocked(GraphApplyStatus::Committed, "initialize");
}

GraphDescription GraphTransactionHost::describeGraph() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return describeGraphLocked();
}

GraphApplyResult GraphTransactionHost::applyGraph(GraphApplyRequest request) {
  std::lock_guard<std::mutex> lock(mutex_);

  if (!initialized_ || activePlan_ == nullptr) {
    return rejectedLocked(
        std::move(request.transactionId),
        wasInvalidated_ ? GraphErrorCode::EngineInvalidated
                        : GraphErrorCode::EngineUnavailable,
        GraphFailureStage::Lifecycle,
        wasInvalidated_ ? "The native engine instance was invalidated"
                        : "The native engine has not been initialized");
  }

  if (request.transactionId.empty()) {
    return rejectedLocked({}, GraphErrorCode::InvalidRequest,
                          GraphFailureStage::Validate,
                          "Graph transaction id must not be empty");
  }
  if (lastApplyResult_.has_value() &&
      lastApplyResult_->transactionId == request.transactionId) {
    return *lastApplyResult_;
  }

  if (request.expectedEngineInstance != engineInstance_) {
    return staleLocked(std::move(request.transactionId),
                       GraphErrorCode::StaleEngineInstance,
                       GraphFailureStage::Lifecycle,
                       "Graph request targets a stale engine instance");
  }
  if (request.expectedRouteEpoch != routeEpoch_) {
    return staleLocked(std::move(request.transactionId),
                       GraphErrorCode::StaleRouteEpoch,
                       GraphFailureStage::Route,
                       "Audio route changed before graph commit");
  }
  if (request.expectedGeneration != activePlan_->generation()) {
    return staleLocked(std::move(request.transactionId),
                       GraphErrorCode::StaleGeneration,
                       GraphFailureStage::Commit,
                       "Graph generation changed before commit");
  }

  GraphFailure failure;
  auto plan = RenderPlan::Prepare(
      sampleRate_, maxFramesPerBlock_, activePlan_->generation() + 1,
      std::move(request.nodes), std::move(request.connections), &failure
#if defined(DAFT_AUDIO_ENABLE_GRAPH_FAULT_INJECTION)
      ,
      request.injectedFailure);
#else
      );
#endif
  if (plan == nullptr) {
    auto result = resultLocked(GraphApplyStatus::Rejected,
                               std::move(request.transactionId),
                               std::move(failure));
    lastApplyResult_ = result;
    return result;
  }

#if defined(DAFT_AUDIO_ENABLE_GRAPH_FAULT_INJECTION)
  if (plan->shouldInjectCommitFailure()) {
    auto result = rejectedLocked(
        std::move(request.transactionId), GraphErrorCode::CommitRejected,
        GraphFailureStage::Commit, "Injected render-plan commit failure");
    return result;
  }
#endif

  if (plan->graphHash() == activePlan_->graphHash()) {
    auto result =
        resultLocked(GraphApplyStatus::Committed, request.transactionId);
    lastApplyResult_ = result;
    return result;
  }

  if (!publishLocked(&plan->graph(), engineInstance_)) {
    auto result = rejectedLocked(
        std::move(request.transactionId), GraphErrorCode::CommitRejected,
        GraphFailureStage::Commit,
        "Render callback rejected the prepared graph publication");
    return result;
  }

  auto retired = std::move(activePlan_);
  activePlan_ = std::move(plan);
  retireAndQuiesceLocked(std::move(retired));

  auto result =
      resultLocked(GraphApplyStatus::Committed, request.transactionId);
  lastApplyResult_ = result;
  return result;
}

GraphApplyResult GraphTransactionHost::recoverAudioConfiguration(
    std::uint64_t expectedEngineInstance,
    std::string transactionId) {
  std::lock_guard<std::mutex> lock(mutex_);

  if (!initialized_ || activePlan_ == nullptr) {
    return rejectedLocked(
        std::move(transactionId),
        wasInvalidated_ ? GraphErrorCode::EngineInvalidated
                        : GraphErrorCode::EngineUnavailable,
        GraphFailureStage::Lifecycle,
        "Cannot recover audio configuration without an active render plan");
  }
  if (expectedEngineInstance != engineInstance_) {
    return staleLocked(std::move(transactionId),
                       GraphErrorCode::StaleEngineInstance,
                       GraphFailureStage::Lifecycle,
                       "Configuration recovery targets a stale engine");
  }
  if (!publishLocked(&activePlan_->graph(), engineInstance_)) {
    return rejectedLocked(
        std::move(transactionId),
        GraphErrorCode::AudioConfigurationChanged, GraphFailureStage::Route,
        "Unable to republish the graph after an audio configuration change");
  }

  ++routeEpoch_;
  lastApplyResult_.reset();
  try {
    if (quiesce_) {
      quiesce_();
      retiredPlans_.clear();
    } else {
      retiredPlans_.clear();
    }
  } catch (...) {
    // The active graph remains valid. Retired plans stay owned until a later
    // successful quiescence point instead of risking a render use-after-free.
  }
  return resultLocked(GraphApplyStatus::Committed, std::move(transactionId));
}

bool GraphTransactionHost::invalidate(
    std::uint64_t expectedEngineInstance) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!initialized_ || expectedEngineInstance != engineInstance_) {
    return false;
  }
  if (!publishLocked(nullptr, engineInstance_)) {
    return false;
  }

  auto retired = std::move(activePlan_);
  initialized_ = false;
  wasInvalidated_ = true;
  lastApplyResult_.reset();
  retireAndQuiesceLocked(std::move(retired));
  return true;
}

bool GraphTransactionHost::isInitialized() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return initialized_;
}

GraphDescription GraphTransactionHost::describeGraphLocked() const {
  GraphDescription description;
  description.routeEpoch = routeEpoch_;
  description.engineInstance = engineInstance_;
  if (activePlan_ != nullptr) {
    description.generation = activePlan_->generation();
    description.graphHash = activePlan_->graphHash();
    description.nodeIds = activePlan_->nodeIds();
  }
  return description;
}

GraphApplyResult GraphTransactionHost::resultLocked(
    GraphApplyStatus status,
    std::string transactionId,
    std::optional<GraphFailure> failure) const {
  GraphApplyResult result;
  result.status = status;
  result.transactionId = std::move(transactionId);
  result.graph = describeGraphLocked();
  result.failure = std::move(failure);
  return result;
}

GraphApplyResult GraphTransactionHost::staleLocked(
    std::string transactionId,
    GraphErrorCode code,
    GraphFailureStage stage,
    std::string detail) const {
  return resultLocked(GraphApplyStatus::Stale, std::move(transactionId),
                      MakeFailure(stage, code, std::move(detail)));
}

GraphApplyResult GraphTransactionHost::rejectedLocked(
    std::string transactionId,
    GraphErrorCode code,
    GraphFailureStage stage,
    std::string detail) const {
  return resultLocked(GraphApplyStatus::Rejected, std::move(transactionId),
                      MakeFailure(stage, code, std::move(detail)));
}

bool GraphTransactionHost::publishLocked(
    SceneGraph* graph,
    std::uint64_t engineInstance) {
  if (!publish_) {
    return false;
  }
  try {
    return publish_(graph, engineInstance);
  } catch (...) {
    return false;
  }
}

void GraphTransactionHost::retireAndQuiesceLocked(
    std::unique_ptr<RenderPlan> retired) {
  if (retired != nullptr) {
    retiredPlans_.push_back(std::move(retired));
  }
  if (!quiesce_) {
    retiredPlans_.clear();
    return;
  }

  try {
    quiesce_();
    retiredPlans_.clear();
  } catch (...) {
    // Keep every retired plan alive. A later recovery, commit, or invalidation
    // can reclaim them after the render callback reaches quiescence.
  }
}

}  // namespace daft::audio
