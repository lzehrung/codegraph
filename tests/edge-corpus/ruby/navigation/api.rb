module Atlas # @def atlas @coverage atlas complete
  module Engine # @def engine @coverage engine complete
    class Device # @def device @coverage device complete @known-gap reopened_class_coverage observed=partial
      attr_accessor :name # @def accessor

      def initialize(name) # @def initialize
        self.name = name # @ref accessor @known-gap generated_accessor_write observed=none
      end

      def ready? # @def ready
        !name.empty? # @goto accessor @known-gap generated_accessor_read_goto observed=not_found
      end

      def reset! # @def reset
        self.name = "" # @goto accessor @known-gap generated_accessor_setter_goto observed=name_reader
      end

      def name=(value) # @def name_writer
        @name = value
      end

      def name # @def name_reader
        @name
      end
    end

    class Registry # @def registry @coverage registry complete
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
