import api

def before_rebinding():
    return api.run()  # @ref importedRun @known-gap imported_module_member_reference observed=none
    return api.run()  # @goto importedRun=run @known-gap imported_module_member_goto observed=not_found

api = object()
api.run()  # @not-ref importedRun
