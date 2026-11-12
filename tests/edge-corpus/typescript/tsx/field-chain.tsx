class Controller {
    open() {} // @def open
}

type PanelProps = { controller: Controller };

function FieldChain(props: PanelProps) {
    props.controller.open(); // @ref open
    props.controller.open(); // @goto open
}
