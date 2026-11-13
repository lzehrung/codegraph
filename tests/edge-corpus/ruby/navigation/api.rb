module Atlas # @def atlas=Atlas @coverage atlas complete
  module Engine # @def engine=Engine @coverage engine complete
    class Device # @def device=Device @coverage device complete @known-gap reopened_class_coverage observed=partial
      attr_accessor :name
      attr_accessor :serial # @def serial=:serial @coverage serial complete @known-gap typed_local_reader_reference observed=partial

      def initialize(name) # @def initialize
        self.name = name # @ref name_writer
        self.serial = 0 # @ref serial
      end

      def ready? # @def ready=ready?
        !name.empty? # @goto name_reader
      end

      def reset! # @def reset=reset!
        self.name = "" # @goto name_writer
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
