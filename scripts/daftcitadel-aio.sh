#!/usr/bin/env bash
# DaftCitadel all-in-one repair, verification, build, and deployment driver.
# Safe default: with no action flags, it only verifies the repository.

set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_NAME=$(basename "$0")
EAS_CLI_VERSION="${EAS_CLI_VERSION:-21.0.2}"
EAS_PROFILE="${EAS_PROFILE:-production}"
PR_CHECK_TIMEOUT_SECONDS="${PR_CHECK_TIMEOUT_SECONDS:-1800}"
PLATFORM="all"
WEB_OUTPUT="single"
WEB_ALIAS=""
GITHUB_BRANCH=""
PR_TITLE="chore: validate and deploy DaftCitadel"
PR_BODY="Automated by scripts/daftcitadel-aio.sh after local verification and builds."

DO_REPAIR=false
DO_VERIFY=false
DO_LOCAL_BUILDS=false
DO_DOCKER=false
DO_EAS_BUILD=false
DO_WEB_DEPLOY=false
DO_GITHUB=false
DO_MERGE=false
DO_SUBMIT=false
DO_ANDROID_RELEASE=false
CONFIGURE_WEB=true
SKIP_NPM_CI=false
SKIP_UNAVAILABLE=false
ALLOW_DIRTY=false
SYNC_GIT=true
ASSUME_YES=false
DRY_RUN=false
ACTION_SELECTED=false
PUBLISHED_PR=""
WEB_EXPORTED=false

usage() {
  cat <<EOF_USAGE
Usage: $SCRIPT_NAME [options]

Actions:
  --repair-issue-74       Apply the stranded issue #74 patch and remove bootstrap files.
  --verify               Install dependencies and run all repository verification gates.
  --local-builds         Build web, Android debug, and iOS Simulator targets when selected.
  --docker               Build Docker images for apex and citadel profiles.
  --eas-build            Build selected native platforms with EAS profile '$EAS_PROFILE'.
  --deploy-web           Export and deploy web to EAS Hosting.
  --github               Commit, push, and open/update a GitHub pull request.
  --merge                Watch PR checks, then squash-merge and delete the branch.
  --submit               Build with EAS and auto-submit selected native platforms.
  --all                  Run repair, verification, local builds, Docker, GitHub, EAS, and web deploy.

Selection and behavior:
  --platform=VALUE       all, ios, android, or web. Default: all.
  --eas-profile=NAME     EAS build profile. Default: production.
  --web-output=VALUE     single, static, or server. Default: single.
  --web-alias=NAME       Deploy web to an alias instead of production.
  --branch=NAME          Git branch for --github. Default: codex/aio-<timestamp>.
  --pr-title=TEXT        Pull request title.
  --android-release      Also run Gradle bundleRelease locally.
  --no-configure-web     Do not add expo.web.output when deploying web.
  --skip-npm-ci          Reuse current node_modules instead of running npm ci.
  --skip-unavailable     Skip host-incompatible builds instead of failing.
  --allow-dirty          Permit a dirty working tree before the script starts.
  --no-sync              Skip git fetch/pull before work begins.
  --yes                  Skip destructive/deployment confirmation prompts.
  --dry-run              Print commands without executing them.
  -h, --help             Show this help.

Examples:
  $SCRIPT_NAME --verify --local-builds
  $SCRIPT_NAME --all --yes
  $SCRIPT_NAME --all --submit --merge --yes
  $SCRIPT_NAME --platform=ios --verify --local-builds
EOF_USAGE
}

log() {
  printf '\n[AIO] %s\n' "$*"
}

warn() {
  printf '\n[AIO][WARN] %s\n' "$*" >&2
}

die() {
  printf '\n[AIO][ERROR] %s\n' "$*" >&2
  exit 1
}

quote_cmd() {
  printf '%q ' "$@"
  printf '\n'
}

run() {
  printf '[AIO][RUN] '
  quote_cmd "$@"
  if $DRY_RUN; then
    return 0
  fi
  "$@"
}

run_in() {
  local directory=$1
  shift
  printf '[AIO][RUN:%s] ' "$directory"
  quote_cmd "$@"
  if $DRY_RUN; then
    return 0
  fi
  (
    cd "$directory"
    "$@"
  )
}

run_with_timeout() {
  local timeout_seconds=$1
  shift
  printf '[AIO][RUN timeout=%ss] ' "$timeout_seconds"
  quote_cmd "$@"
  if $DRY_RUN; then
    return 0
  fi

  "$@" &
  local command_pid=$!
  local deadline=$(( $(date +%s) + timeout_seconds ))

  while kill -0 "$command_pid" 2>/dev/null; do
    if (( $(date +%s) >= deadline )); then
      kill "$command_pid" 2>/dev/null || true
      wait "$command_pid" 2>/dev/null || true
      die "Command timed out after ${timeout_seconds}s."
    fi
    sleep 5
  done

  wait "$command_pid"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

selected() {
  local target=$1
  [[ "$PLATFORM" == "all" || "$PLATFORM" == "$target" ]]
}

confirm() {
  local prompt=$1
  if $ASSUME_YES; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "$prompt Re-run with --yes in a non-interactive shell."
  fi
  local answer=""
  read -r -p "$prompt [y/N] " answer
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) die "Cancelled." ;;
  esac
}

skip_or_die() {
  local message=$1
  if $SKIP_UNAVAILABLE; then
    warn "$message Skipping."
    return 0
  fi
  die "$message"
}

for arg in "$@"; do
  case "$arg" in
    --repair-issue-74) DO_REPAIR=true; ACTION_SELECTED=true ;;
    --verify) DO_VERIFY=true; ACTION_SELECTED=true ;;
    --local-builds) DO_LOCAL_BUILDS=true; ACTION_SELECTED=true ;;
    --docker) DO_DOCKER=true; ACTION_SELECTED=true ;;
    --eas-build) DO_EAS_BUILD=true; ACTION_SELECTED=true ;;
    --deploy-web) DO_WEB_DEPLOY=true; ACTION_SELECTED=true ;;
    --github) DO_GITHUB=true; ACTION_SELECTED=true ;;
    --merge) DO_MERGE=true; DO_GITHUB=true; ACTION_SELECTED=true ;;
    --submit) DO_SUBMIT=true; DO_EAS_BUILD=true; ACTION_SELECTED=true ;;
    --android-release) DO_ANDROID_RELEASE=true; DO_LOCAL_BUILDS=true; ACTION_SELECTED=true ;;
    --all)
      DO_REPAIR=true
      DO_VERIFY=true
      DO_LOCAL_BUILDS=true
      DO_DOCKER=true
      DO_EAS_BUILD=true
      DO_WEB_DEPLOY=true
      DO_GITHUB=true
      ACTION_SELECTED=true
      ;;
    --platform=*) PLATFORM=${arg#*=} ;;
    --eas-profile=*) EAS_PROFILE=${arg#*=} ;;
    --web-output=*) WEB_OUTPUT=${arg#*=} ;;
    --web-alias=*) WEB_ALIAS=${arg#*=} ;;
    --branch=*) GITHUB_BRANCH=${arg#*=} ;;
    --pr-title=*) PR_TITLE=${arg#*=} ;;
    --no-configure-web) CONFIGURE_WEB=false ;;
    --skip-npm-ci) SKIP_NPM_CI=true ;;
    --skip-unavailable) SKIP_UNAVAILABLE=true ;;
    --allow-dirty) ALLOW_DIRTY=true ;;
    --no-sync) SYNC_GIT=false ;;
    --yes) ASSUME_YES=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

if ! $ACTION_SELECTED; then
  DO_VERIFY=true
fi

case "$PLATFORM" in
  all|ios|android|web) ;;
  *) die "Unsupported platform '$PLATFORM'. Use all, ios, android, or web." ;;
esac

case "$WEB_OUTPUT" in
  single|static|server) ;;
  *) die "Unsupported web output '$WEB_OUTPUT'. Use single, static, or server." ;;
esac

command_exists git || die "git is required."
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "Run this script inside the DaftCitadel Git repository."
cd "$ROOT"

[[ -f package.json ]] || die "package.json not found at repository root."
[[ -f scripts/daftcitadel.sh ]] || die "scripts/daftcitadel.sh not found."

unset DAFT_CITADEL_REPO_ROOT
export EXPO_NO_TELEMETRY=1

WORKTREE_DIRTY=false
if [[ -n $(git status --porcelain) ]]; then
  WORKTREE_DIRTY=true
  if ! $ALLOW_DIRTY; then
    die "Working tree is dirty. Commit/stash changes or pass --allow-dirty."
  fi
fi

if [[ -z "$GITHUB_BRANCH" ]]; then
  GITHUB_BRANCH="codex/aio-$(date -u '+%Y%m%d-%H%M%S')"
fi

sync_repository() {
  if ! $SYNC_GIT; then
    log "Skipping git synchronization by request."
    return 0
  fi

  if $WORKTREE_DIRTY; then
    warn "Working tree is dirty; fetching refs but skipping pull."
    run git fetch origin --prune
    return 0
  fi

  run git fetch origin --prune
  local branch
  branch=$(git branch --show-current)
  if [[ "$branch" == "main" ]]; then
    run git pull --ff-only origin main
  elif [[ -n "$branch" ]] && git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    run git pull --ff-only
  else
    warn "Current branch has no upstream; fetch completed without pull."
  fi
}

repair_issue_74() {
  local patch=.github/issue-74-installer-metadata.patch
  local bootstrap=.github/workflows/issue-74-bootstrap.yml
  local encoder_fixed=false
  local metadata_test_present=false

  grep -Fq 'sys.stdout.write(base64.b64encode(sys.stdin.buffer.read()).decode("ascii"))' \
    scripts/daftcitadel.sh && encoder_fixed=true
  node -e 'const p=require("./package.json"); process.exit(p.scripts?.["test:installer-metadata"] ? 0 : 1)' \
    >/dev/null 2>&1 && metadata_test_present=true

  if $encoder_fixed && $metadata_test_present; then
    log "Issue #74 implementation is already present."
  elif [[ -f "$patch" ]]; then
    log "Applying the stranded issue #74 implementation patch."
    run git apply --check "$patch"
    run git apply "$patch"
  else
    die "Issue #74 is not implemented and $patch is unavailable."
  fi

  if [[ -e "$patch" || -e "$bootstrap" ]]; then
    log "Removing temporary issue #74 bootstrap machinery."
    run rm -f "$patch" "$bootstrap"
  fi

  if [[ -f .github/workflows/installer-metadata.yml ]]; then
    if $DRY_RUN; then
      printf '[AIO][RUN] pin actions/checkout in .github/workflows/installer-metadata.yml\n'
    else
      python3 - <<'PY_PIN_CHECKOUT'
from pathlib import Path

path = Path('.github/workflows/installer-metadata.yml')
source = path.read_text(encoding='utf-8')
source = source.replace(
    'uses: actions/checkout@v4',
    'uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
)
path.write_text(source, encoding='utf-8')
PY_PIN_CHECKOUT
    fi
  fi
}

configure_web_output() {
  command_exists node || die "Node.js is required to configure app.json."
  if ! $CONFIGURE_WEB; then
    return 0
  fi

  log "Ensuring expo.web.output is '$WEB_OUTPUT'."
  if $DRY_RUN; then
    printf '[AIO][RUN] update app.json expo.web.output=%q\n' "$WEB_OUTPUT"
    return 0
  fi

  WEB_OUTPUT_VALUE="$WEB_OUTPUT" node <<'NODE_WEB_OUTPUT'
const fs = require('node:fs');
const path = 'app.json';
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
config.expo ??= {};
config.expo.web ??= {};
config.expo.web.output = process.env.WEB_OUTPUT_VALUE;
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE_WEB_OUTPUT
}

install_dependencies() {
  command_exists node || die "Node.js is required."
  command_exists npm || die "npm is required."

  if $SKIP_NPM_CI; then
    log "Skipping npm ci by request."
  else
    run npm ci
  fi
}

verify_repository() {
  log "Running focused syntax and metadata checks."
  command_exists bash || die "bash is required."
  command_exists python3 || die "python3 is required."

  run bash -n scripts/daftcitadel.sh
  run bash -n scripts/rvictl-capture.sh
  run python3 -m py_compile scripts/generate_metadata.py
  run node --check scripts/verifyInstaller.js
  run node --test scripts/__tests__/verifyInstaller.test.js

  if node -e 'const p=require("./package.json"); process.exit(p.scripts?.["test:installer-metadata"] ? 0 : 1)'; then
    run npm run test:installer-metadata
  else
    warn "test:installer-metadata is absent; issue #74 may not be applied."
  fi

  run npm run verify:sanitize
}

build_web_local() {
  log "Exporting Expo web bundle."
  run npx expo export --platform web
  WEB_EXPORTED=true
  [[ -d dist || $DRY_RUN == true ]] || die "Expo web export did not produce dist/."
}

build_android_local() {
  command_exists java || { skip_or_die "Java is required for Android builds."; return; }
  [[ -x android/gradlew ]] || { skip_or_die "android/gradlew is missing or not executable."; return; }

  log "Building Android debug APK."
  run_in android ./gradlew --no-daemon clean app:assembleDebug --stacktrace

  if $DO_ANDROID_RELEASE; then
    log "Building Android release AAB."
    run_in android ./gradlew --no-daemon app:bundleRelease --stacktrace
  fi
}

find_ios_workspace() {
  find ios -maxdepth 1 -name '*.xcworkspace' -print -quit
}

find_ios_scheme() {
  local workspace=$1
  local output
  output=$(mktemp)

  if ! xcodebuild -list -json -workspace "$workspace" >"$output"; then
    rm -f "$output"
    return 1
  fi

  local scheme
  if ! scheme=$(python3 - "$output" <<'PY_SCHEME'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    payload = json.load(handle)
schemes = payload.get('workspace', {}).get('schemes', [])
for preferred in ('DaftCitadel', 'Daft Citadel'):
    if preferred in schemes:
        print(preferred)
        raise SystemExit(0)
for candidate in schemes:
    if candidate.lower() != 'pods':
        print(candidate)
        raise SystemExit(0)
raise SystemExit(1)
PY_SCHEME
  ); then
    rm -f "$output"
    return 1
  fi

  rm -f "$output"
  printf '%s\n' "$scheme"
}

build_ios_local() {
  if [[ $(uname -s) != Darwin ]]; then
    skip_or_die "A local iOS build requires macOS."
    return
  fi
  command_exists xcodebuild || { skip_or_die "xcodebuild is required for iOS builds."; return; }
  command_exists pod || { skip_or_die "CocoaPods is required for iOS builds."; return; }

  log "Installing CocoaPods dependencies."
  run_in ios pod install

  local workspace
  workspace=$(find_ios_workspace)
  [[ -n "$workspace" ]] || die "No .xcworkspace found in ios/ after pod install."

  local scheme
  scheme=$(find_ios_scheme "$workspace") || die "Unable to discover an iOS scheme in $workspace."

  log "Building iOS Simulator target: workspace=$workspace scheme=$scheme"
  run xcodebuild \
    -workspace "$workspace" \
    -scheme "$scheme" \
    -configuration Debug \
    -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$ROOT/ios/build/DerivedData" \
    CODE_SIGNING_ALLOWED=NO \
    clean build
}

build_local_targets() {
  if selected web; then
    build_web_local
  fi
  if selected android; then
    build_android_local
  fi
  if selected ios; then
    build_ios_local
  fi
}

build_docker_images() {
  command_exists docker || { skip_or_die "Docker is required for container builds."; return; }

  log "Building DaftCitadel Docker images."
  run docker build --progress=plain --build-arg PROFILE=apex -t daftcitadel:apex .
  run docker build --progress=plain --build-arg PROFILE=citadel -t daftcitadel:citadel .
}

eas() {
  run npx --yes "eas-cli@$EAS_CLI_VERSION" "$@"
}

check_eas_auth() {
  log "Checking Expo/EAS authentication with CLI $EAS_CLI_VERSION."
  eas whoami
}

eas_build_mobile() {
  if [[ "$PLATFORM" == web ]]; then
    warn "--eas-build has no mobile platform selected."
    return 0
  fi

  check_eas_auth
  local eas_platform=$PLATFORM
  [[ "$eas_platform" == all || "$eas_platform" == ios || "$eas_platform" == android ]] || \
    die "Invalid EAS platform: $eas_platform"

  local args=(build --platform "$eas_platform" --profile "$EAS_PROFILE")
  if $DO_SUBMIT; then
    args+=(--auto-submit)
  fi
  if [[ -n "${EXPO_TOKEN:-}" || "${CI:-}" == "true" ]]; then
    args+=(--non-interactive)
  fi

  log "Starting EAS native build for platform=$eas_platform profile=$EAS_PROFILE."
  eas "${args[@]}"
}

deploy_web() {
  selected web || { warn "Web is not selected; skipping EAS Hosting deployment."; return 0; }

  configure_web_output
  if ! $WEB_EXPORTED; then
    build_web_local
  fi
  check_eas_auth

  if [[ -n "$WEB_ALIAS" ]]; then
    log "Deploying web bundle to EAS Hosting alias '$WEB_ALIAS'."
    eas deploy --alias "$WEB_ALIAS"
  else
    log "Deploying web bundle to EAS Hosting production."
    eas deploy --prod
  fi
}

github_publish() {
  command_exists gh || die "GitHub CLI (gh) is required for --github."
  run gh auth status

  local current_branch
  current_branch=$(git branch --show-current)
  if [[ -z "$current_branch" || "$current_branch" == main || "$current_branch" == master ]]; then
    log "Creating deployment branch $GITHUB_BRANCH."
    run git switch -c "$GITHUB_BRANCH"
    current_branch=$GITHUB_BRANCH
  fi

  run git add -A
  if git diff --cached --quiet; then
    log "No repository changes to commit."
  else
    run git commit -m "chore: add DaftCitadel AIO build and deploy flow"
  fi

  run git push -u origin "$current_branch"

  PUBLISHED_PR=$(gh pr view "$current_branch" --json url --jq .url 2>/dev/null || true)
  if [[ -z "$PUBLISHED_PR" ]]; then
    if $DRY_RUN; then
      PUBLISHED_PR="<dry-run-pr>"
      printf '[AIO][RUN] gh pr create --base main --head %q --title %q ...\n' \
        "$current_branch" "$PR_TITLE"
    else
      PUBLISHED_PR=$(gh pr create \
        --base main \
        --head "$current_branch" \
        --title "$PR_TITLE" \
        --body "$PR_BODY")
    fi
  else
    log "Using existing pull request: $PUBLISHED_PR"
  fi
}

merge_pull_request() {
  command_exists gh || die "GitHub CLI (gh) is required for --merge."
  local target=${PUBLISHED_PR:-}
  if [[ -z "$target" ]]; then
    target=$(gh pr view --json url --jq .url 2>/dev/null || true)
  fi
  [[ -n "$target" ]] || die "No pull request is available to merge."

  confirm "Watch checks and squash-merge $target?"
  run_with_timeout "$PR_CHECK_TIMEOUT_SECONDS" gh pr checks "$target" --watch
  run gh pr merge "$target" --squash --delete-branch
}

summarize() {
  log "Completed requested DaftCitadel AIO actions."
  printf 'Repository:  %s\n' "$ROOT"
  printf 'Platform:    %s\n' "$PLATFORM"
  printf 'EAS profile: %s\n' "$EAS_PROFILE"
  [[ -d dist ]] && printf 'Web output:   %s\n' "$ROOT/dist"
  [[ -f android/app/build/outputs/apk/debug/app-debug.apk ]] && \
    printf 'Android APK:  %s\n' "$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
  [[ -n "$PUBLISHED_PR" ]] && printf 'Pull request: %s\n' "$PUBLISHED_PR"
}

if $DO_SUBMIT || $DO_EAS_BUILD || $DO_WEB_DEPLOY || $DO_GITHUB || $DO_MERGE; then
  confirm "This run may push code or deploy externally. Continue?"
fi

sync_repository

if $DO_REPAIR; then
  repair_issue_74
fi

if $DO_WEB_DEPLOY; then
  configure_web_output
fi

if $DO_VERIFY || $DO_LOCAL_BUILDS || $DO_WEB_DEPLOY; then
  install_dependencies
fi

if $DO_VERIFY; then
  verify_repository
fi

if $DO_LOCAL_BUILDS; then
  build_local_targets
fi

if $DO_DOCKER; then
  build_docker_images
fi

if $DO_GITHUB; then
  github_publish
fi

if $DO_EAS_BUILD; then
  eas_build_mobile
fi

if $DO_WEB_DEPLOY; then
  deploy_web
fi

if $DO_MERGE; then
  merge_pull_request
fi

summarize
