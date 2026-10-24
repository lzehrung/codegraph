import api

api.run()  # @ref importedRun
api.run()  # @goto importedRun=run

api = object()
api.run()  # @not-ref importedRun
