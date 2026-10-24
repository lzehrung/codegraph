module Atlas # @def atlas=Atlas @coverage atlas complete
  module Engine # @def engine=Engine @coverage engine complete
    class Device # @def device=Device @coverage device complete @known-gap reopened_class_coverage observed=partial
      attr_accessor :name
      attr_accessor :serial # @def serial=:serial @coverage serial complete @known-gap generated_accessor_not_indexed observed=not_found

      def initialize(name) # @def initialize
        self.name = name # @ref name_writer @known-gap self_setter_call_reference observed=none
        self.serial = 0 # @ref serial @known-gap generated_accessor_not_indexed observed=none
      end

      def ready? # @def ready=ready?
        !name.empty? # @goto name_reader
      end

      def reset! # @def reset=reset!
        self.name = "" # @goto name_writer @known-gap self_setter_call_goes_to_reader observed=name_reader
      end

      def name=(value) # @def name_writer=name
        @name = value
      end

      def name # @def name_reader=name
        @name
      end
    end

    class Registry # @def registry=Registry @coverage registry complete
      def self.build(device) # @def build
        device
      end

      def self.find # @def find
        Device # @ref device @goto device
      end

      def lookup # @def lookup
        Device # @ref device @goto device
      end
    end
  end
end
