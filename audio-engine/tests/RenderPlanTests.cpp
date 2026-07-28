#include "audio_engine/RenderPlan.h"

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
}
