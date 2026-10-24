module Atlas # @ref atlas
  module Engine # @ref engine
    module Auditable # @def auditable @coverage auditable complete
      def audit # @def audit
        :ok
      end
    end

    module FactoryMethods # @def factory_methods @coverage factory_methods complete
      def make # @def make
        Device.new("made")
      end
    end

    class Device
      include Auditable # @ref auditable @goto auditable
      extend FactoryMethods # @ref factory_methods @goto factory_methods

      def audit_twice # @def audit_twice
        audit # @ref audit @goto audit
      end
    end
  end
end
