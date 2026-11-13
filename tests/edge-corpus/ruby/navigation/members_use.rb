require_relative "members"
require_relative "members_decoy"

Gauge.new.full? # @ref full_q @not-ref full_plain
Gauge.new.drain! # @ref drain_bang
Gauge.new.level # @ref level
Gauge.new.mode # @ref mode
Gauge.new.label = "y" # @ref label_writer @not-ref label_reader
Settings.config = 1 # @ref config_writer
Dial.new.full? # @not-ref full_q
Dial.new.level # @goto dial_level=level
Dial.new.label = "z" # @not-ref label_writer
