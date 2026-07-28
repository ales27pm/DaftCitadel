#include "audio_engine/RenderPlan.h"

#include <algorithm>
#include <exception>
#include <iomanip>
#include <new>
#include <sstream>
#include <unordered_set>
#include <utility>

namespace daft::audio {
namespace {

constexpr std::uint64_t kFnvOffsetBasis = 14695981039346656037ULL;
constexpr std::uint64_t kFnvPrime = 1099511628211ULL;
constexpr const char* kGraphOutputBus = "__output__";

void SetFailure(GraphFailure* failure,
                GraphFailureStage stage,
                GraphErrorCode code,
                std::string nodeId,
                std::string detail) {
  if (failure == nullptr) {
    return;
  }

  failure->stage = stage;
  failure->code = code;
  failure->nodeId = std::move(nodeId);
  failure->detail = std::move(detail);
}

std::string HashCanonicalGraph(
    const std::vector<PreparedGraphNode>& nodes,
    const std::vector<GraphConnectionDefinition>& connections) {
  std::uint64_t hash = kFnvOffsetBasis;
  const auto append = [&hash](const std::string& value) {
    for (const unsigned char character : value) {
      hash ^= character;
      hash *= kFnvPrime;
    }
    hash ^= 0xff;
    hash *= kFnvPrime;
  };

  for (const auto& node : nodes) {
    append(node.id);
    append(node.type);
    append(node.optionsFingerprint);
  }
  for (const auto& connection : connections) {
    append(connection.source);
    append(connection.destination);
  }

  std::ostringstream stream;
  stream << std::hex << std::setfill('0') << std::setw(16) << hash;
  return stream.str();
}

}  // namespace

const char* GraphFailureStageName(GraphFailureStage stage) noexcept {
  switch (stage) {
    case GraphFailureStage::None:
      return "none";
    case GraphFailureStage::Validate:
      return "validate";
    case GraphFailureStage::Allocate:
      return "allocate";
    case GraphFailureStage::Prepare:
      return "prepare";
    case GraphFailureStage::Connect:
      return "connect";
    case GraphFailureStage::Commit:
      return "commit";
    case GraphFailureStage::Lifecycle:
      return "lifecycle";
    case GraphFailureStage::Route:
      return "route";
  }
  return "unknown";
}

const char* GraphErrorCodeName(GraphErrorCode code) noexcept {
  switch (code) {
    case GraphErrorCode::None:
      return "none";
    case GraphErrorCode::InvalidRequest:
      return "invalid_request";
    case GraphErrorCode::DuplicateNode:
      return "duplicate_node";
    case GraphErrorCode::MissingEndpoint:
      return "missing_endpoint";
    case GraphErrorCode::ResourceAllocationFailed:
      return "resource_allocation_failed";
    case GraphErrorCode::NodePreparationFailed:
      return "node_preparation_failed";
    case GraphErrorCode::ConnectionRejected:
      return "connection_rejected";
    case GraphErrorCode::CommitRejected:
      return "commit_rejected";
    case GraphErrorCode::StaleGeneration:
      return "stale_generation";
    case GraphErrorCode::StaleRouteEpoch:
      return "stale_route_epoch";
    case GraphErrorCode::StaleEngineInstance:
      return "stale_engine_instance";
    case GraphErrorCode::EngineUnavailable:
      return "engine_unavailable";
    case GraphErrorCode::EngineInvalidated:
      return "engine_invalidated";
    case GraphErrorCode::AudioConfigurationChanged:
      return "audio_configuration_changed";
  }
  return "unknown";
}

const char* GraphApplyStatusName(GraphApplyStatus status) noexcept {
  switch (status) {
    case GraphApplyStatus::Committed:
      return "committed";
    case GraphApplyStatus::Stale:
      return "stale";
    case GraphApplyStatus::Rejected:
      return "rejected";
  }
  return "unknown";
}

RenderPlan::RenderPlan(double sampleRate,
                       std::size_t maxFramesPerBlock,
                       std::uint64_t generation,
                       std::string graphHash,
                       std::vector<std::string> nodeIds,
                       bool injectCommitFailure)
    : graph_(sampleRate, maxFramesPerBlock),
      generation_(generation),
      graphHash_(std::move(graphHash)),
      nodeIds_(std::move(nodeIds)),
      injectCommitFailure_(injectCommitFailure) {}

std::unique_ptr<RenderPlan> RenderPlan::Prepare(
    double sampleRate,
    std::size_t maxFramesPerBlock,
    std::uint64_t generation,
    std::vector<PreparedGraphNode> nodes,
    std::vector<GraphConnectionDefinition> connections,
    GraphFailure* failure,
    GraphFailureStage injectedFailure) {
  if (failure != nullptr) {
    *failure = {};
  }

  if (injectedFailure == GraphFailureStage::Validate) {
    SetFailure(failure, GraphFailureStage::Validate,
               GraphErrorCode::InvalidRequest, {},
               "Injected graph validation failure");
    return nullptr;
  }

  if (sampleRate <= 0.0 || maxFramesPerBlock == 0) {
    SetFailure(failure, GraphFailureStage::Validate,
               GraphErrorCode::InvalidRequest, {},
               "Sample rate and maximum block size must be positive");
    return nullptr;
  }

  std::sort(nodes.begin(), nodes.end(),
            [](const PreparedGraphNode& lhs, const PreparedGraphNode& rhs) {
              return lhs.id < rhs.id;
            });
  std::sort(connections.begin(), connections.end(),
            [](const GraphConnectionDefinition& lhs,
               const GraphConnectionDefinition& rhs) {
              if (lhs.source != rhs.source) {
                return lhs.source < rhs.source;
              }
              return lhs.destination < rhs.destination;
            });

  std::unordered_set<std::string> nodeIds;
  nodeIds.reserve(nodes.size());
  for (const auto& node : nodes) {
    if (node.id.empty() || node.type.empty() || node.node == nullptr) {
      SetFailure(failure, GraphFailureStage::Validate,
                 GraphErrorCode::InvalidRequest, node.id,
                 "Every graph node needs an id, type, and prepared DSP node");
      return nullptr;
    }
    if (!nodeIds.insert(node.id).second) {
      SetFailure(failure, GraphFailureStage::Validate,
                 GraphErrorCode::DuplicateNode, node.id,
                 "Graph node ids must be unique");
      return nullptr;
    }
  }

  for (const auto& connection : connections) {
    if (connection.source.empty() || connection.destination.empty() ||
        nodeIds.count(connection.source) == 0 ||
        (connection.destination != kGraphOutputBus &&
         nodeIds.count(connection.destination) == 0)) {
      SetFailure(failure, GraphFailureStage::Validate,
                 GraphErrorCode::MissingEndpoint, {},
                 "Every connection endpoint must reference a graph node");
      return nullptr;
    }
  }

  if (injectedFailure == GraphFailureStage::Allocate) {
    SetFailure(failure, GraphFailureStage::Allocate,
               GraphErrorCode::ResourceAllocationFailed, {},
               "Injected render-plan allocation failure");
    return nullptr;
  }

  const std::string graphHash = HashCanonicalGraph(nodes, connections);
  std::vector<std::string> sortedNodeIds;
  sortedNodeIds.reserve(nodes.size());
  for (const auto& node : nodes) {
    sortedNodeIds.push_back(node.id);
  }

  std::unique_ptr<RenderPlan> plan;
  try {
    plan.reset(new RenderPlan(
        sampleRate, maxFramesPerBlock, generation, graphHash,
        std::move(sortedNodeIds),
        injectedFailure == GraphFailureStage::Commit));
  } catch (const std::bad_alloc&) {
    SetFailure(failure, GraphFailureStage::Allocate,
               GraphErrorCode::ResourceAllocationFailed, {},
               "Unable to allocate the render plan");
    return nullptr;
  } catch (const std::exception& exception) {
    SetFailure(failure, GraphFailureStage::Allocate,
               GraphErrorCode::ResourceAllocationFailed, {},
               exception.what());
    return nullptr;
  }

  if (injectedFailure == GraphFailureStage::Prepare) {
    SetFailure(failure, GraphFailureStage::Prepare,
               GraphErrorCode::NodePreparationFailed, {},
               "Injected node preparation failure");
    return nullptr;
  }

  try {
    for (auto& node : nodes) {
      const std::string nodeId = node.id;
      if (!plan->graph_.addNode(nodeId, std::move(node.node))) {
        SetFailure(failure, GraphFailureStage::Prepare,
                   GraphErrorCode::NodePreparationFailed, nodeId,
                   "SceneGraph rejected the prepared node");
        return nullptr;
      }
    }
  } catch (const std::bad_alloc&) {
    SetFailure(failure, GraphFailureStage::Allocate,
               GraphErrorCode::ResourceAllocationFailed, {},
               "Unable to allocate graph node resources");
    return nullptr;
  } catch (const std::exception& exception) {
    SetFailure(failure, GraphFailureStage::Prepare,
               GraphErrorCode::NodePreparationFailed, {},
               exception.what());
    return nullptr;
  }

  if (injectedFailure == GraphFailureStage::Connect) {
    SetFailure(failure, GraphFailureStage::Connect,
               GraphErrorCode::ConnectionRejected, {},
               "Injected graph connection failure");
    return nullptr;
  }

  for (const auto& connection : connections) {
    if (!plan->graph_.connect(connection.source, connection.destination)) {
      SetFailure(failure, GraphFailureStage::Connect,
                 GraphErrorCode::ConnectionRejected, connection.source,
                 "SceneGraph rejected the connection");
      return nullptr;
    }
  }

  return plan;
}

}  // namespace daft::audio
