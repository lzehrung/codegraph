require_relative "api"
require_relative "mixins"

class Atlas::Engine::Device # @ref atlas @goto atlas
  def label # @def label
    ready? # @ref ready @known-gap predicate_method_call observed=none
  end
end

item = Atlas::Engine::Device.new("sensor") # @ref atlas @goto atlas
item.name = "probe" # @ref name_writer @known-gap attr_accessor_setter_reference observed=none
item.name # @ref name_reader @known-gap attr_accessor_reader_reference observed=none
item.ready? # @ref ready @known-gap predicate_method_reference observed=none
item.reset! # @ref reset @known-gap bang_method_reference observed=none
item.audit # @ref audit @known-gap included_mixin_method_reference observed=none
item.audit_twice # @ref audit_twice @known-gap reopened_instance_method_reference observed=none
Atlas::Engine::Device.make # @ref factory_methods @ref make @known-gap class_method_lookup observed=none
Atlas::Engine::Registry.build(item) # @ref build @known-gap class_method_lookup observed=none
Atlas::Engine::Registry.find # @ref find @known-gap class_method_lookup observed=none
Atlas::Engine::Registry.new.lookup # @ref lookup @known-gap instance_method_lookup observed=none

values = [1, 2].map do |value; item_local| # @def value_param=value @def item_local
  item_local = value # @ref item_local @known-gap block_local_write observed=none
  value # @ref value_param
end

text = <<~MESSAGE # @def text
  Atlas::Engine::Device item.ready? item.reset! # intentional decoy names in heredoc
MESSAGE
# Atlas Engine Device Registry ready? reset! audit are comment decoys.
quoted = "Atlas::Engine::Device ready? reset! audit" # string decoy
