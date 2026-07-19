require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'DaftCitadelNative'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = package['license']
  s.author           = package['author']
  s.homepage         = package['homepage']
  s.platform         = :ios, '15.1'
  s.swift_version    = '5.9'
  s.static_framework = true
  s.source           = { :git => package['repository']['url'], :tag => s.version }

  s.dependency 'ExpoModulesCore'
  s.dependency 'React-Core'

  s.frameworks = 'AVFoundation', 'AudioToolbox', 'NetworkExtension'

  s.source_files = [
    '*.{h,m,mm,swift,hpp,cpp}',
    '../../../native/audio/ios/**/*.{h,m,mm,swift,hpp,cpp}',
    '../../../native/collab/ios/**/*.{h,m,mm,swift,hpp,cpp}',
    '../../../native/plugins/ios/**/*.{h,m,mm,swift,hpp,cpp}',
    '../../../audio-engine/include/**/*.{h,hpp}',
    '../../../audio-engine/src/**/*.{m,mm,cpp}',
    '../../../audio-engine/platform/common/**/*.{h,hpp,m,mm,cpp}',
    '../../../audio-engine/platform/ios/**/*.{h,hpp,m,mm,cpp}'
  ]

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)/../../.."',
      '"$(PODS_TARGET_SRCROOT)/../../../audio-engine/include"',
      '"$(PODS_TARGET_SRCROOT)/../../../audio-engine/platform/common"',
      '"$(PODS_TARGET_SRCROOT)/../../../audio-engine/platform/ios"'
    ].join(' ')
  }
end
