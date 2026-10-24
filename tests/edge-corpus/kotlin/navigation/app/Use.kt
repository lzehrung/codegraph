package sample.app

import sample.model.Box
import sample.other.Foo
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
    val record = makeRecord("Ada") // @ref build @goto build=makeRecord
    val named = Entry(name = record.name, rank = 2) // @ref Record @goto Record=Entry
    val label = renderRecord(named) // @ref render @goto render=renderRecord
    val summary = named.summary // @not-ref summary
    val compact = named.renderCompact("*") // @ref compact @known-gap extension_function_alias_unresolved observed=none
    val twin = named.twin // @not-ref twin
    val formatted = Formatter.format(named) // @ref format @goto format
    val box = Box.create("payload") // @ref create @goto create @ref Box
    val boxRead = box.read() // @not-ref read
    val inner = box.Inner() // @not-ref Inner
    val outer = inner.outerValue() // @not-ref outerValue
    val viaOuter = inner.fromOuter() // @not-ref fromOuter
    val intOverload = overload(3) // @not-ref overload @not-ref overloadString
    val stringOverload = overload("three") // @not-ref overload @not-ref overloadString
    val withDefault = defaulted(value = "done") // @ref defaulted @goto defaulted
    val pair = PairBox(left = label, right = compact) // @ref left @ref right @known-gap data_class_named_arguments_unresolved observed=none
    val pairAgain = PairBox(label, compact) // @ref PairBox @goto PairBox
    val objValue = objectRead() // @ref objectRead @goto objectRead
    val otherRecord = sample.decoy.Record("decoy") // @not-ref Record
    val otherRender = sample.decoy.render(otherRecord) // @not-ref render
    val explicitFoo = Foo() // @goto importedFoo=Foo @not-ref samePackageFoo
    val decoy = "renderRecord summary compact overload"
    val rawDecoy = """build Formatter payload this@Box"""
    // decoy mention: overload summary this@Box
    return label + summary + compact + twin + formatted + boxRead + outer + viaOuter + intOverload + stringOverload + withDefault + pair.left + pairAgain.right + objValue + otherRender + decoy + rawDecoy
}
