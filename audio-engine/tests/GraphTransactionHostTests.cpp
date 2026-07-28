#include "audio_engine/GraphTransactionHost.h"

#include <array>
#include <cmath>
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

  std::array<float, 128> left{};
  std::array<float, 128> right{};
  float* channels[] = {left.data(), right.data()};
  daft::audio::AudioBufferView offlineBuffer(channels, 2, left.size());
  SineOscillatorNode offlineOscillator;
  offlineOscillator.prepare(48000.0);
  offlineOscillator.setParameter("frequency", 440.0);
  offlineOscillator.process(offlineBuffer);
  double renderedEnergy = 0.0;
  for (const float sample : left) {
    renderedEnergy += std::abs(static_cast<double>(sample));
  }
  RequireTransaction(renderedEnergy > 0.0,
                     "Offline oscillator render produced only silence");

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
  RequireTransaction(publicationCount >= 3,
                     "Lifecycle did not publish expected graph transitions");
  RequireTransaction(quiescenceCount >= 3,
                     "Lifecycle did not establish render quiescence");
}
