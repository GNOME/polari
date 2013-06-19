const Gio = imports.gi.Gio;

function createActions(actionEntries) {
   return actionEntries.map(
        function(actionEntry) {
            let props = {};
            ['name', 'state', 'parameter_type'].forEach(
                function(prop) {
                    if (actionEntry[prop])
                        props[prop] = actionEntry[prop];
                });
            let action = new Gio.SimpleAction(props);
            if (actionEntry.activate)
                action.connect('activate', actionEntry.activate);
            if (actionEntry.change_state)
                action.connect('change-state', actionEntry.change_state);
            return action;
    });
}
