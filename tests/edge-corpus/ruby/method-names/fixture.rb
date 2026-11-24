module SymbolTools
  def calculate # @def calculate @coverage calculate complete
    42
  end
  module_function :calculate # @ref calculate @goto calculate=:calculate
end

class OperandMeter
  def total(value = 99) # @def method_total=total
    value
  end

  def work(x = 2, mask = 3, scale = 2)
    total = 10 # @def local_total=total @coverage local_total complete
    difference = total -1 # @ref local_total @goto local_total=total @not-ref method_total
    masked = total &mask
    product = total *scale
    [difference, masked, product, total(), self.total]
  end
end

class ReflectiveMeter
  def reflective # @def reflective @coverage reflective partial
    7
  end

  def unrelated
    8
  end
end

def read_reflectively(other)
  other.send(:reflective)
end

p [SymbolTools.calculate, OperandMeter.new.work, read_reflectively(ReflectiveMeter.new)]
