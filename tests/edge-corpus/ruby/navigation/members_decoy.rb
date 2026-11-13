class Dial
  attr_reader :level, "unit" # @def dial_level=:level
  attr_accessor :mode

  def full?
    true
  end

  def drain!
    nil
  end

  def label=(value)
    @label = value
  end

  def label
    @label
  end
end
