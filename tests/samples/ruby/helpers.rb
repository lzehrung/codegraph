require "json"

module Helpers
  def self.helper_from_helpers
    JSON.generate({ ok: true })
  end
end
