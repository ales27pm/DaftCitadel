#include "audio_engine/GraphTransactionHost.h"

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

namespace {

void RequireTransaction(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

}  // namespace

namespace daft::audio::tests {

void RunGraphTransactionHostTests() {
  using daft::audio::GraphApplyRequest;
  using daft::audio::GraphApplyStatus;
  using daft::audio::GraphErrorCode;
  using daft::audio::GraphFailureStage;
  using daft::audio::GraphTransactionHost;
  using daft::audio::PreparedGraphNode;
  using daft::audio::SceneGraph;
  using daft::audio::SineOscillatorNode;

  SceneGraph* publishedGraph = nullptr;
  std::uint64_t publicationCount = 0;
  std::uint64_t quiescenceCount = 0;
  std::uint64_t publishedEngineInstance = 0;
  GraphTransactionHost host(
      48000.0, 512,
      [&](SceneGraph* graph, std::uint64_t engineInstance) {
        publishedGraph = graph;
        publishedEngineInstance = engineInstance;
        ++publicationCount;
        return true;
      },
      [&] { ++quiescenceCount; });

  const auto invalidInitialization = host.initialize(0);
  RequireTransaction(invalidInitialization.status == GraphApplyStatus::Rejected,
                     "Zero engine instance was not rejected");

  const auto initialized = host.initialize(41);
  RequireTransaction(initialized.status == GraphApplyStatus::Committed,
                     "Graph host initialization failed");
  RequireTransaction(publishedGraph != nullptr,
                     "Initialization did not publish a graph");
  RequireTransaction(publishedEngineInstance == 41,
                     "Initialization published the wrong engine instance");
  const auto initial = host.describeGraph();
  RequireTransaction(initial.engineInstance == 41,
                     "Graph description lost the engine instance");
  RequireTransaction(initial.routeEpoch == 1,
                     "Graph description did not start a route epoch");
  RequireTransaction(!initial.graphHash.empty(),
                     "Graph description did not expose a graph hash");

  GraphApplyRequest stale;
  stale.transactionId = "stale-generation";
  stale.expectedGeneration = initial.generation + 1;
  stale.expectedRouteEpoch = initial.routeEpoch;
  stale.expectedEngineInstance = initial.engineInstance;
  const auto staleResult = host.applyGraph(std::move(stale));
  RequireTransaction(staleResult.status == GraphApplyStatus::Stale,
                     "Stale generation was not rejected");
  RequireTransaction(staleResult.failure.has_value() &&
                         staleResult.failure->code ==
                             GraphErrorCode::StaleGeneration,
                     "Stale generation returned the wrong error code");

  GraphApplyRequest populated;
  populated.transactionId = "populated-plan";
  populated.expectedGeneration = initial.generation;
  populated.expectedRouteEpoch = initial.routeEpoch;
  populated.expectedEngineInstance = initial.engineInstance;
  PreparedGraphNode oscillator;
  oscillator.id = "oscillator";
  oscillator.type = "sine";
  oscillator.optionsFingerprint = "frequency=440";
  oscillator.node = std::make_unique<SineOscillatorNode>();
  populated.nodes.push_back(std::move(oscillator));
  populated.connections.push_back({"oscillator", "__output__"});
  const auto populatedResult = host.applyGraph(std::move(populated));
  RequireTransaction(populatedResult.status == GraphApplyStatus::Committed,
                     "Prepared non-empty graph was not committed");
  RequireTransaction(populatedResult.graph.generation ==
                         initial.generation + 1,
                     "Committed graph did not advance generation");
  RequireTransaction(populatedResult.graph.nodeIds.size() == 1 &&
                         populatedResult.graph.nodeIds.front() == "oscillator",
                     "Committed graph did not expose canonical node ids");
  RequireTransaction(populatedResult.graph.graphHash != initial.graphHash,
                     "Different graph topology retained the old hash");

  const auto publicationCountAfterCommit = publicationCount;
  GraphApplyRequest replay;
  replay.transactionId = "populated-plan";
  replay.expectedGeneration = initial.generation;
  replay.expectedRouteEpoch = initial.routeEpoch;
  replay.expectedEngineInstance = initial.engineInstance;
  const auto replayResult = host.applyGraph(std::move(replay));
  RequireTransaction(
      replayResult.status == GraphApplyStatus::Committed &&
          replayResult.graph.generation == populatedResult.graph.generation &&
          replayResult.graph.graphHash == populatedResult.graph.graphHash,
      "Committed transaction replay did not return its cached result");
  RequireTransaction(publicationCount == publicationCountAfterCommit,
                     "Committed transaction replay unexpectedly published");

  GraphApplyRequest noOp;
  noOp.transactionId = "equivalent-idempotent-plan";
  noOp.expectedGeneration = populatedResult.graph.generation;
  noOp.expectedRouteEpoch = initial.routeEpoch;
  noOp.expectedEngineInstance = initial.engineInstance;
  PreparedGraphNode equivalentOscillator;
  equivalentOscillator.id = "oscillator";
  equivalentOscillator.type = "sine";
  equivalentOscillator.optionsFingerprint = "frequency=440";
  equivalentOscillator.node = std::make_unique<SineOscillatorNode>();
  noOp.nodes.push_back(std::move(equivalentOscillator));
  noOp.connections.push_back({"oscillator", "__output__"});
  const auto noOpResult = host.applyGraph(std::move(noOp));
  RequireTransaction(noOpResult.status == GraphApplyStatus::Committed,
                     "Equivalent graph transaction was not acknowledged");
  RequireTransaction(noOpResult.graph.generation ==
                         populatedResult.graph.generation,
                     "Equivalent graph unnecessarily advanced generation");
  RequireTransaction(publicationCount == publicationCountAfterCommit,
                     "Equivalent graph unexpectedly published");

  GraphApplyRequest fault;
  fault.transactionId = "commit-fault";
  fault.expectedGeneration = populatedResult.graph.generation;
  fault.expectedRouteEpoch = initial.routeEpoch;
  fault.expectedEngineInstance = initial.engineInstance;
  fault.injectedFailure = GraphFailureStage::Commit;
  PreparedGraphNode faultOscillator;
  faultOscillator.id = "oscillator";
  faultOscillator.type = "sine";
  faultOscillator.optionsFingerprint = "frequency=880";
  faultOscillator.node = std::make_unique<SineOscillatorNode>();
  fault.nodes.push_back(std::move(faultOscillator));
  fault.connections.push_back({"oscillator", "__output__"});
  const auto faultResult = host.applyGraph(std::move(fault));
  RequireTransaction(faultResult.status == GraphApplyStatus::Rejected,
                     "Injected commit failure was ignored");
  RequireTransaction(host.describeGraph().generation ==
                         populatedResult.graph.generation,
                     "Rejected commit changed the active generation");
  RequireTransaction(publicationCount == publicationCountAfterCommit,
                     "Rejected commit unexpectedly published");

  const auto recovered = host.recoverAudioConfiguration(41);
  RequireTransaction(recovered.status == GraphApplyStatus::Committed,
                     "Audio configuration recovery failed");
  RequireTransaction(recovered.graph.routeEpoch == initial.routeEpoch + 1,
                     "Recovery did not advance the route epoch");

  RequireTransaction(!host.invalidate(40),
                     "A stale owner invalidated the active engine");
  RequireTransaction(host.invalidate(41),
                     "The active owner could not invalidate the engine");
  RequireTransaction(publishedGraph == nullptr,
                     "Invalidation did not unpublish the render graph");

  GraphApplyRequest afterInvalidation;
  afterInvalidation.transactionId = "after-invalidation";
  afterInvalidation.expectedGeneration = 0;
  afterInvalidation.expectedRouteEpoch = recovered.graph.routeEpoch;
  afterInvalidation.expectedEngineInstance = 41;
  const auto invalidatedResult =
      host.applyGraph(std::move(afterInvalidation));
  RequireTransaction(invalidatedResult.status == GraphApplyStatus::Rejected,
                     "Invalidated engine accepted a graph transaction");
  RequireTransaction(invalidatedResult.failure.has_value() &&
                         invalidatedResult.failure->code ==
                             GraphErrorCode::EngineInvalidated,
                     "Invalidated engine returned the wrong error code");
  RequireTransaction(
      publicationCount == 4,
      "Lifecycle did not publish initialize, commit, recovery, and invalidation");
  RequireTransaction(
      quiescenceCount == 4,
      "Lifecycle did not quiesce initialize, commit, recovery, and invalidation");

  bool allowPublication = true;
  std::uint64_t retryPublicationCount = 0;
  GraphTransactionHost retryHost(
      48000.0, 512,
      [&](SceneGraph*, std::uint64_t) {
        ++retryPublicationCount;
        return allowPublication;
      },
      {});
  RequireTransaction(
      retryHost.initialize(99).status == GraphApplyStatus::Committed,
      "Host without a quiesce callback failed to initialize");
  const auto retryInitial = retryHost.describeGraph();

  const auto makeRetryRequest = [&] {
    GraphApplyRequest request;
    request.transactionId = "retry-publication";
    request.expectedGeneration = retryInitial.generation;
    request.expectedRouteEpoch = retryInitial.routeEpoch;
    request.expectedEngineInstance = retryInitial.engineInstance;
    PreparedGraphNode retryOscillator;
    retryOscillator.id = "retry-oscillator";
    retryOscillator.type = "sine";
    retryOscillator.optionsFingerprint = "frequency=220";
    retryOscillator.node = std::make_unique<SineOscillatorNode>();
    request.nodes.push_back(std::move(retryOscillator));
    return request;
  };

  allowPublication = false;
  const auto rejectedPublication = retryHost.applyGraph(makeRetryRequest());
  RequireTransaction(rejectedPublication.status == GraphApplyStatus::Rejected,
                     "Rejected publication was not reported");
  allowPublication = true;
  const auto committedRetry = retryHost.applyGraph(makeRetryRequest());
  RequireTransaction(committedRetry.status == GraphApplyStatus::Committed,
                     "Rejected publication was not retryable");
  RequireTransaction(
      retryPublicationCount == 3,
      "Retry host did not publish initialization and both commit attempts");
}

}  // namespace daft::audio::tests
