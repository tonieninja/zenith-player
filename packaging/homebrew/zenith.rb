cask "zenith" do
  version "4.7.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/tonieninja/zenith-player/releases/download/v#{version}/Zenith_#{version}_universal.dmg"
  name "Zenith"
  desc "Music player with synced lyrics, crossfade and plugins"
  homepage "https://github.com/tonieninja/zenith-player"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on :macos

  app "Zenith.app"

  zap trash: [
    "~/Library/Application Support/com.zenithplayer.desktop",
    "~/Library/Caches/com.zenithplayer.desktop",
    "~/Library/Preferences/com.zenithplayer.desktop.plist",
    "~/Library/Saved Application State/com.zenithplayer.desktop.savedState",
    "~/Library/WebKit/com.zenithplayer.desktop",
  ]

  caveats <<~EOS
    Zenith is not affiliated with Google or YouTube.

    The macOS build has not been tested on a real Mac, and it is not signed or
    notarized by Apple, so Gatekeeper blocks the first start. Allow it in
    System Settings > Privacy & Security > Open Anyway, or remove the quarantine flag:
      xattr -dr com.apple.quarantine "#{appdir}/Zenith.app"
  EOS
end
