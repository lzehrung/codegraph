class Controller {
    open() {} // @def open
}

type PanelProps = { controller: Controller };

function FieldChain(props: PanelProps) {
    props.controller.open(); // @ref open @known-gap typed_field_chain_reference observed=none
    props.controller.open(); // @goto open @known-gap typed_field_chain_goto observed=not_found
}
