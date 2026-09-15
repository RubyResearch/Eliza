require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ElizaosCapacitorBrowserSurface'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license'] || { :type => 'MIT' }
  s.homepage = 'https://elizaos.ai'
  s.authors = { 'elizaOS' => 'dev@elizaos.ai' }
  s.source = { :git => 'https://github.com/elizaOS/eliza.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.resource_bundles = { 'ElizaBrowserSurface' => ['resources/read-page.js'] }
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
  s.frameworks = 'WebKit', 'UIKit'
end
