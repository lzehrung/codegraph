from ..source import public_value as relative_value  # @ref public_value
from ..source import *
from .. import exported_value  # @ref public_value
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..models import User  # @ref User

def use(value: User):  # @ref User @known-gap type_checking_annotation_reference_not_recorded observed=none
    typed: User = value
    first = relative_value()  # @ref public_value @goto public_value
    second = public_value()  # @ref public_value
    return first + second + exported_value()  # @ref public_value
