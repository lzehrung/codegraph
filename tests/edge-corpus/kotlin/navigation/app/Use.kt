package sample.app

import sample.model.Box
import sample.model.Formatter
import sample.model.PairBox
import sample.model.Record as Entry
import sample.model.build as makeRecord
import sample.model.compact as renderCompact
import sample.model.defaulted
import sample.model.objectRead
import sample.model.overload
import sample.model.render as renderRecord
import sample.model.summary
import sample.model.twin

fun use(): String {
    val record = makeRecord("Ada") // @ref build @goto build
    val named = Entry(name = record.name, rank = 2) // @ref Record @goto Record
    val label = renderRecord(named) // @ref render @goto render
    val summary = named.summary // @ref summary @known-gap extension_property_receiver_unresolved observed=none
    val compact = named.renderCompact("*") // @ref compact @known-gap extension_function_alias_unresolved observed=none
    val twin = named.twin // @ref twin @known-gap extension_property_receiver_unresolved observed=none
    val formatted = Formatter.format(named) // @ref format @goto format
    val box = Box.create("payload") // @ref create @goto create @ref Box
    val boxRead = box.read() // @ref read @known-gap typed_receiver_member_unresolved observed=none
    val inner = box.Inner() // @ref Inner @known-gap inner_constructor_receiver_unresolved observed=none
    val outer = inner.outerValue() // @ref outerValue @known-gap inner_member_receiver_unresolved observed=none
    val viaOuter = inner.fromOuter() // @ref fromOuter @known-gap inner_member_receiver_unresolved observed=none
    val intOverload = overload(3) // @ref overload @known-gap aliased_overload_import_unresolved observed=none
    val stringOverload = overload("three") // @ref overloadString @known-gap aliased_overload_import_unresolved observed=none
    val withDefault = defaulted(value = "done") // @ref defaulted @goto defaulted
    val pair = PairBox(left = label, right = compact) // @ref left @ref right @known-gap data_class_named_arguments_unresolved observed=none
    val pairAgain = PairBox(label, compact) // @ref PairBox @goto PairBox
    val objValue = objectRead() // @ref objectRead @goto objectRead
    val otherRecord = sample.decoy.Record("decoy") // @not-ref Record
    val otherRender = sample.decoy.render(otherRecord) // @not-ref render
    val decoy = "renderRecord summary compact overload"
    val rawDecoy = """build Formatter payload this@Box"""
    // decoy mention: overload summary this@Box
    return label + summary + compact + twin + formatted + boxRead + outer + viaOuter + intOverload + stringOverload + withDefault + pair.left + pairAgain.right + objValue + otherRender + decoy + rawDecoy
}
