require_relative "foo"

class NestedCaller
  def self.build
    ["RootTarget", NestedTarget.new] # @ref nestedTarget @goto nestedTarget=NestedTarget @not-ref rootTarget
  end
end
