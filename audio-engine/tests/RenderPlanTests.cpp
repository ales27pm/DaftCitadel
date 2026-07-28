#include "audio_engine/RenderPlan.h"

#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

void Require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

}  // namespace

namespace daft::audio::tests {

void RunRenderPlanTests() {
  using daft::audio::GraphConnectionDefinition;
  using daft::audio::GraphErrorCode;
  using daft::audio::GraphFailure;
  using daft::audio::GraphFailureStage;
  using daft::audio::PreparedGraphNode;
  using daft::audio::RenderPlan;

  GraphFailure failure;
  auto first = RenderPlan::Prepare(48000.0, 512, 7, {}, {}, &failure);
  Require(first != nullptr, "An empty render plan should be valid");
  Require(first->generation() == 7, "Render plan generation was not retained");
  Require(first->nodeIds().empty(), "Empty render plan exposed node ids");
  Require(!first->graphHash().empty(), "Render plan hash must not be empty");

  auto second = RenderPlan::Prepare(48000.0, 512, 8, {}, {}, &failure);
  Require(second != nullptr, "Second empty render plan should be valid");
  Require(first->graphHash() == second->graphHash(),
          "Equivalent render plans must have deterministic hashes");

  std::vector<GraphConnectionDefinition> invalidConnections{
      {"missing-source", "missing-destination"}};
  auto invalid = RenderPlan::Prepare(
      48000.0, 512, 9, {}, std::move(invalidConnections), &failure);
  Require(invalid == nullptr, "Missing endpoints should reject a render plan");
  Require(failure.stage == GraphFailureStage::Validate,
          "Missing endpoints should fail during validation");
  Require(failure.code == GraphErrorCode::MissingEndpoint,
          "Missing endpoints returned the wrong error code");

  auto injected = RenderPlan::Prepare(
      48000.0, 512, 10, {}, {}, &failure, GraphFailureStage::Allocate);
  Require(injected == nullptr, "Injected allocation failure was ignored");
  Require(failure.stage == GraphFailureStage::Allocate,
          "Injected failure returned the wrong stage");

  auto commitFault = RenderPlan::Prepare(
      48000.0, 512, 11, {}, {}, &failure, GraphFailureStage::Commit);
  Require(commitFault != nullptr,
          "Commit fault must leave a prepared plan available for publication");
  Require(commitFault->shouldInjectCommitFailure(),
          "Prepared plan did not retain the commit fault");

  const auto makeNode = [](std::string id, std::string type,
                           std::string fingerprint) {
    PreparedGraphNode node;
    node.id = std::move(id);
    node.type = std::move(type);
    node.optionsFingerprint = std::move(fingerprint);
    node.node = std::make_unique<daft::audio::SineOscillatorNode>();
    return node;
  };
  const auto makePopulatedPlan =
      [&](std::uint64_t generation, bool reverseOrder,
          std::string oscillatorId, std::string oscillatorType,
          std::string oscillatorFingerprint) {
        std::vector<PreparedGraphNode> nodes;
        if (reverseOrder) {
          nodes.push_back(makeNode("output", "gain", "gain=1"));
          nodes.push_back(makeNode(oscillatorId, oscillatorType,
                                   oscillatorFingerprint));
        } else {
          nodes.push_back(makeNode(oscillatorId, oscillatorType,
                                   oscillatorFingerprint));
          nodes.push_back(makeNode("output", "gain", "gain=1"));
        }
        std::vector<GraphConnectionDefinition> connections;
        if (reverseOrder) {
          connections.push_back({"output", "__output__"});
          connections.push_back({oscillatorId, "output"});
        } else {
          connections.push_back({oscillatorId, "output"});
          connections.push_back({"output", "__output__"});
        }
        return RenderPlan::Prepare(
            48000.0, 512, generation, std::move(nodes),
            std::move(connections), &failure);
      };

  auto populatedFirst =
      makePopulatedPlan(12, false, "oscillator", "sine", "frequency=440");
  auto populatedEquivalent =
      makePopulatedPlan(13, true, "oscillator", "sine", "frequency=440");
  auto differentFingerprint =
      makePopulatedPlan(14, true, "oscillator", "sine", "frequency=880");
  auto differentType =
      makePopulatedPlan(15, true, "oscillator", "alternate", "frequency=440");
  auto differentIdentity =
      makePopulatedPlan(16, true, "oscillator-2", "sine", "frequency=440");
  Require(populatedFirst != nullptr && populatedEquivalent != nullptr &&
              differentFingerprint != nullptr && differentType != nullptr &&
              differentIdentity != nullptr,
          "Populated render plans should prepare");
  Require(populatedFirst->graphHash() == populatedEquivalent->graphHash(),
          "Graph hash should ignore declaration order");
  Require(populatedFirst->graphHash() != differentFingerprint->graphHash(),
          "Graph hash should include option fingerprints");
  Require(populatedFirst->graphHash() != differentType->graphHash(),
          "Graph hash should include node types");
  Require(populatedFirst->graphHash() != differentIdentity->graphHash(),
          "Graph hash should include node identities");

  std::vector<PreparedGraphNode> duplicateNodes;
  duplicateNodes.push_back(makeNode("duplicate", "sine", "a"));
  duplicateNodes.push_back(makeNode("duplicate", "sine", "b"));
  auto duplicate = RenderPlan::Prepare(
      48000.0, 512, 17, std::move(duplicateNodes), {}, &failure);
  Require(duplicate == nullptr &&
              failure.code == GraphErrorCode::DuplicateNode,
          "Duplicate node ids should be rejected");

  std::vector<PreparedGraphNode> emptyIdNodes;
  emptyIdNodes.push_back(makeNode("", "sine", "a"));
  Require(RenderPlan::Prepare(48000.0, 512, 18,
                              std::move(emptyIdNodes), {}, &failure) == nullptr &&
              failure.code == GraphErrorCode::InvalidRequest,
          "Empty node ids should be rejected");
  std::vector<PreparedGraphNode> emptyTypeNodes;
  emptyTypeNodes.push_back(makeNode("node", "", "a"));
  Require(RenderPlan::Prepare(48000.0, 512, 19,
                              std::move(emptyTypeNodes), {}, &failure) == nullptr &&
              failure.code == GraphErrorCode::InvalidRequest,
          "Empty node types should be rejected");
  std::vector<PreparedGraphNode> nullNodes(1);
  nullNodes.front().id = "node";
  nullNodes.front().type = "sine";
  Require(RenderPlan::Prepare(48000.0, 512, 20, std::move(nullNodes), {},
                              &failure) == nullptr &&
              failure.code == GraphErrorCode::InvalidRequest,
          "Null prepared nodes should be rejected");
  Require(RenderPlan::Prepare(0.0, 512, 21, {}, {}, &failure) == nullptr &&
              failure.code == GraphErrorCode::InvalidRequest,
          "Non-positive sample rate should be rejected");
  Require(RenderPlan::Prepare(48000.0, 0, 22, {}, {}, &failure) == nullptr &&
              failure.code == GraphErrorCode::InvalidRequest,
          "Zero frame capacity should be rejected");

  for (const auto stage : {GraphFailureStage::Validate,
                           GraphFailureStage::Prepare,
                           GraphFailureStage::Connect}) {
    auto failed =
        RenderPlan::Prepare(48000.0, 512, 23, {}, {}, &failure, stage);
    Require(failed == nullptr && failure.stage == stage,
            "Injected failure reported the wrong stage");
  }
}

}  // namespace daft::audio::tests
