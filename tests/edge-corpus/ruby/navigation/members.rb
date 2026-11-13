class Gauge
  attr_reader :level, "unit" # @def level=:level @def unit=unit @coverage level complete
  attr_writer :target # @def target=:target
  attr_accessor :mode # @def mode=:mode

  def full? # @def full_q=full? @coverage full_q complete
    level > 0 # @ref level
  end

  def full # @def full_plain=full
    level
  end

  def drain! # @def drain_bang=drain!
    self.target = 0 # @ref target
    self.mode = :idle # @ref mode
  end

  def drain # @def drain_plain=drain
    1
  end

  def label=(value) # @def label_writer=label
    @label = value
  end

  def label # @def label_reader=label
    @label
  end

  def check
    full? # @ref full_q @not-ref full_plain
    full # @ref full_plain
    drain! # @ref drain_bang @not-ref drain_plain
    drain # @ref drain_plain
    self.unit # @goto unit
    self.label = "x" # @goto label_writer @not-ref label_reader
    self.label # @goto label_reader @not-ref label_writer
  end
end

class Settings
  def self.config=(value) # @def config_writer=config
    @config = value
  end

  def self.config # @def config_reader=config
    @config
  end
end
