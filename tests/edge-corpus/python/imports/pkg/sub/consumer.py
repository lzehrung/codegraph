from ..source import public_value as relative_value  # @ref public_value
from ..source import *
from .. import exported_value  # @ref public_value @not-ref submoduleExport
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..models import User  # @ref User

def use(value: User):  # @ref User @known-gap type_checking_annotation_reference_not_recorded observed=none
    typed: User = value
    first = relative_value()  # @ref public_value @goto public_value=relative_value
    second = public_value()  # @ref public_value
    return first + second + exported_value()  # @ref public_value

if True: from ..source import public_value as inline_value

def use_inline_suite():
    return inline_value()  # @goto public_value=inline_value

if TYPE_CHECKING:
    if enabled: from ..models import User as nested_user  # @ref User

match True:
    case True: from ..models import User as match_user; from ..source import private_value as match_private  # @ref private_value

from ..models \
    import User as continued_user  # @ref User

if TYPE_CHECKING:
    import pkg.source as source_module, pkg.models as model_module

def use_comma_import():
    return model_module.User()  # @goto User=User

from ..models import User as first_user, User as second_user

def use_second_user():
    return second_user()  # @goto User=second_user
