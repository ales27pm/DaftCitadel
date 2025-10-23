require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'CollabNetworkDiagnostics'
  s.version      = package['version'] || '1.0.0'
  s.summary      = 'CoreWLAN-backed diagnostics bridge for Daft Citadel collaboration tooling.'
  s.description  = 'Exposes Wi-Fi link metrics through React Native for collaboration diagnostics.'
  s.homepage     = 'https://github.com/DaftCitadel/DaftCitadel'
  s.license      = { :type => 'MIT' }
  s.author       = { 'Daft Citadel' => 'engineering@daftcitadel.dev' }
  s.platform     = :ios, '13.0'
  s.source       = { :git => 'https://github.com/DaftCitadel/DaftCitadel.git', :tag => s.version }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.requires_arc = true
  s.swift_version = '5.0'

  s.dependency 'React-Core'
end
