"use strict";

import html from './html/users.html';
import Utils from './modules/utils.js';
import WarpModal from './modules/modal.js';
import GroupChips from './modules/groupChips.js';
import { M } from '../app/materialize.js';
import warpDialog from '../app/dialog.js';
import { createTable } from '../lib/tablePage.js';
import { initFormSelect } from '../lib/formSelect.js';
import { clearFieldError, showFieldError } from '../lib/formDialog.js';
import { confirmDelete } from '../lib/confirmDelete.js';
import { lazyCache } from '../lib/lazyCache.js';
import { labelFormatter, iconFormatter } from '../lib/formatters.js';
import { buildDataTable } from '../lib/dataTable.js';

export { html };

export async function mount(ctx) {
    const root = ctx.root;

    let accountTypes = [
        {label: "---" },
        {label: TR("accountTypes.Admin"), value: 10 },
        {label: TR("accountTypes.User"), value: 20 },
        {label: TR("accountTypes.BLOCKED"), value: 90 }
    ];
    let defaultAccountType = 20;

    var showEditDialog;
    var groupChips;            // GroupChips widget, built on first open
    var groupSource = lazyCache(function() {
        return Utils.xhr.post(
            window.warpGlobals.URLs['usersList'],
            {filter: [{field:"account_type", type:">=", value: window.warpGlobals.accountTypeGroup}]},
            {toastOnSuccess:false, errorOnFailure: false})
        .then( (v) => v.response.data.map( (row) => {
            let label = Utils.makeUserStr(row['login'], row['name']);
            return { id: label, text: label };
        }));
    });

    // labelFormatter walks accountTypes [{label},{value,label}…] and returns
    // labels[0].label (the "---") for an unknown value — identical to the old
    // hand-rolled loop.
    var accountTypeFormatter = labelFormatter(accountTypes);

    var editFormater = iconFormatter({icon: 'edit', colorClass: 'warp-icon-edit-alt'});

    var editClicked = function(e,cell) {
        let data = cell.getRow().getData();
        showEditDialog(data.login, data.account_type, data.name);
    }

    var table = createTable(root.querySelector('#usersTable'), {
        ajaxURL: window.warpGlobals.URLs['usersList'],
        index:"login",
        columns: [
            {formatter:editFormater, width:40, hozAlign:"center", cellClick:editClicked, headerSort:false},
            {title:TR("Login"), field: "login", headerFilter:"input", headerFilterFunc:"starts"},
            {title:TR("User name"), field: "name", headerFilter:"input", headerFilterFunc:"starts"},
            {title:TR("Account type"), field: "account_type", headerFilter:Utils.makeSelect(accountTypes), headerFilterFunc:"=", formatter:accountTypeFormatter  }
        ],
        initialSort: [
            {column:"login", dir:"asc"},
            {column:"name", dir:"asc"}
        ],
        initialFilter: [
            {field:"account_type", type:"<", value: window.warpGlobals.accountTypeGroup}     // don't show groups
        ]
    });

    // Surface a backend-down/5xx on the initial table load as a full-page
    // error view (via the router's mount() rejection) instead of Tabulator's
    // inline alert — see tablePage.js `table.initialLoad`.
    await table.initialLoad;

    showEditDialog = function(login,account_type,name) {

        var editModalEl = root.querySelector('#edit_modal');
        var editModal = warpDialog.getInstance(editModalEl);

        var loginEl = root.querySelector("#login");
        var nameEl = root.querySelector("#name");
        var accountTypeSelectEl = root.querySelector('#account_type_select');
        var password1El = root.querySelector('#password');
        var password2El = root.querySelector('#password2');

        var saveBtn = root.querySelector('#edit_modal_save_btn');
        var deleteBtn = root.querySelector('#edit_modal_delete_btn');

        var errorDiv = root.querySelector("#error_div");
        var errorMsg = root.querySelector("#error_message");

        let addToGroupEl = root.querySelector('#add_to_group');

        if (typeof(editModal) === 'undefined') {

            editModal = warpDialog(editModalEl, {
                onCloseEnd: function() {
                    // we need to tear down materialize select and recreate it
                    // as there is no (exposed) API to select the option
                    let accountTypeSelect = M.FormSelect.getInstance(accountTypeSelectEl);
                    if (accountTypeSelect) {
                        accountTypeSelect.destroy();
                        accountTypeSelectEl.innerHTML = "";
                    }
                }
            });

            var showPassBtns = root.querySelectorAll('.show_password_btn');
            for (let b of showPassBtns) {
                let input = b.parentNode.getElementsByTagName('INPUT')[0];
                b.addEventListener('click', function(e){
                    input.type = input.type == "text"? "password": "text";
                }, {signal: ctx.signal})
            }

            root.querySelector('#generate_password_btn').addEventListener('click', function(e) {
                let array = new Uint8Array(10);
                window.crypto.getRandomValues(array);

                let res = new String();
                let validChars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&*+-:;<=>?@^|";
                for (let i of array) {
                    res = res + validChars[ i % validChars.length ];
                }

                password1El.value = res;
                password1El.type = "text";

                password2El.value = res;
                password2El.type = "text";

                M.updateTextFields();
            }, {signal: ctx.signal});

            var saveBtnClicked = function(e) {

                let err = "";
                if (password1El.value !== password2El.value) {
                    err = TR("Passwords don't match");
                }

                if (loginEl.disabled) {
                    if (nameEl.value === "")
                        err = "Name cannot be empty.";
                }
                else if (loginEl.value === "" || nameEl.value === "" || password1El.value === "") {
                    err = "All fields are mandatory";
                }

                if (err) {
                    showFieldError(errorDiv, errorMsg, err);
                    return;
                }

                clearFieldError(errorDiv, errorMsg);

                let accountTypeSelect = M.FormSelect.getInstance(accountTypeSelectEl);
                let action = loginEl.disabled? "update": "add";

                let actionData = {
                    login: loginEl.value,
                    name: nameEl.value,
                    account_type: parseInt(accountTypeSelect.getSelectedValues()[0]),
                    action: action,
                    groups: []
                };

                if (password1El.value !== "")
                    actionData['password'] = password1El.value;

                for (let g of groupChips.getData())
                    actionData.groups.push( Utils.makeUserStrRev(g.id)[0] );

                Utils.xhr.post(
                    window.warpGlobals.URLs['usersEdit'],
                    actionData,
                    {errorOnFailure: false})
                .then( () => {
                    table.replaceData();
                    editModal.close();
                }).catch( (value) => {
                    showFieldError(errorDiv, errorMsg, value.errorMsg);
                });
            }

            var deleteBtnClicked = function(e) {

                let doDelete = function(force) {
                    let actionData = { login: loginEl.value };
                    if (force) actionData['force'] = true;

                    Utils.xhr.post(
                        window.warpGlobals.URLs['usersDelete'],
                        actionData,
                        {errorOnFailure: false})
                    .then( () => {
                        table.replaceData();
                        editModal.close();
                    }).catch( (value) => {
                        if (value.status == 406) { // past bookings
                            let bookCount = value.response['bookCount'] || 0;
                            let msg = TR("User has XXX bookin(s) ... ",{smart_count:bookCount});
                            confirmDelete(
                                TR("ARE YOU SURE TO DELETE USER: %{user}?",{user:loginEl.value}),
                                msg,
                                {yesText: TR("btn.YES, I'M SURE")}
                            ).then((confirmed) => { if (confirmed) doDelete(true); });
                        }
                        else {
                            WarpModal.getInstance().open(TR("Error"),value.errorMsg);
                        }
                    });
                }

                confirmDelete(
                    TR("Are you sure to delete user: %{user}",{user:loginEl.value}),
                    TR("You will delete the log of user's past bookings. It is usually a better idea to BLOCK the user.")
                ).then((confirmed) => { if (confirmed) doDelete(false); });
            };

            saveBtn.addEventListener('click', saveBtnClicked, {signal: ctx.signal});
            deleteBtn.addEventListener('click', deleteBtnClicked, {signal: ctx.signal});

        }

        login = login || "";
        if (typeof(account_type) === 'undefined')
        account_type = defaultAccountType;
        name = name || "";

        loginEl.value = login;
        loginEl.disabled = login !== "";

        deleteBtn.style.display =
            login !== "" && login !== window.warpGlobals['login'] ? "inline-flex": "none";

        nameEl.value = name;

        for (let r of accountTypes) {
            if (!('value' in r))
                continue;

            let optEl = document.createElement('option');
            optEl.value = r['value'];
            optEl.appendChild( document.createTextNode(r['label']));
            if (r['value'] == account_type)
                optEl.selected = "true";
                accountTypeSelectEl.appendChild(optEl);
        }

        initFormSelect(accountTypeSelectEl);

        password1El.value = "";
        password1El.type = "password";
        password2El.value = "";
        password2El.type = "password";

        clearFieldError(errorDiv, errorMsg);

        M.updateTextFields();

        if (!groupChips)
            groupChips = new GroupChips(addToGroupEl, {
                minLength: 1,
                placeholder: TR("Add to group"),
                // Render the dropdown directly in the dialog (see GroupChips):
                // nested in .modal-content it would be clipped/hidden.
                dropdownContainer: editModalEl
            });

        // The user's currently-assigned groups are fetched per open (new user: none).
        let chipsDataPromise = login
            ? Utils.xhr.get(
                window.warpGlobals.URLs['userGroups'].replace('__LOGIN__',login),
                {toastOnSuccess:false, errorOnFailure: false})
              .then( (v) => v.response.map( (row) => {
                  let label = Utils.makeUserStr(row['login'], row['name']);
                  return { id: label, text: label };
              }))
            : Promise.resolve([]);

        Promise.all([groupSource.get(), chipsDataPromise])
        .then( ([source, selected]) => {
            groupChips.setData(source, selected);
            editModal.open();
        })
        .catch( (v) => {
            let msg = v && v.errorMsg ? v.errorMsg : String(v);
            WarpModal.getInstance().open(TR("Error"), msg);
        });

    }

    root.querySelector('#add_user_btn').addEventListener('click', function(e) {
        showEditDialog();
    }, {signal: ctx.signal});

    var bulkFileEl = root.querySelector('#bulk_import_file');
    var bulkBtn = root.querySelector('#bulk_import_btn');
    bulkBtn.title = TR("bulkImport.Import users from CSV");
    bulkBtn.setAttribute('aria-label', TR("bulkImport.Import users from CSV"));

    function csvEscape(value) {
        let s = value == null ? '' : String(value);
        if (/[",\n\r]/.test(s))
            return '"' + s.replace(/"/g, '""') + '"';
        return s;
    }

    function downloadPasswordsCsv(rows) {
        let lines = ['email,password'];
        for (let r of rows)
            lines.push(csvEscape(r.email) + ',' + csvEscape(r.password));
        let blob = new Blob([lines.join('\n') + '\n'], {type: 'text/csv;charset=utf-8'});
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        a.href = url;
        a.download = 'warp-user-passwords.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function bulkReasonText(reason) {
        let key = 'bulkImport.' + reason;
        return TR.has(key) ? TR(key) : reason;
    }

    function showBulkResult(result) {
        let passwords = result.passwords || [];
        let failed = result.failed || [];
        let created = result.created || 0;

        if (passwords.length)
            downloadPasswordsCsv(passwords);

        let container = document.createElement('div');
        if (created)
            container.appendChild(document.createTextNode(
                TR("bulkImport.Created %{smart_count} user(s)", {smart_count: created})));
        else
            container.appendChild(document.createTextNode(TR("bulkImport.No users were created.")));

        if (failed.length) {
            container.appendChild(document.createElement('br'));
            container.appendChild(document.createElement('br'));
            let failHeader = container.appendChild(document.createElement('b'));
            failHeader.innerText = TR("bulkImport.Failed %{smart_count} row(s)", {smart_count: failed.length});
            container.appendChild(buildDataTable(
                [[TR("bulkImport.Row"), TR("bulkImport.Email"), TR("bulkImport.Reason")]].concat(
                    failed.map(function(f) {
                        return [String(f.row), f.email || '', bulkReasonText(f.reason)];
                    })
                )
            ));
        }

        let buttons = [];
        if (passwords.length)
            buttons.push({ id: 'download', text: TR("btn.Download passwords") });
        buttons.push({ id: 'ok', text: TR("btn.Ok") });

        WarpModal.getInstance().open(TR("bulkImport.Import users from CSV"), container.outerHTML, {
            buttons: buttons,
            onButtonHook: function(id) {
                if (id === 'download' && passwords.length)
                    downloadPasswordsCsv(passwords);
                passwords = [];
            },
            onCancelHook: function() { passwords = []; }
        });
    }

    bulkBtn.addEventListener('click', function() {
        bulkFileEl.click();
    }, {signal: ctx.signal});

    bulkFileEl.addEventListener('change', function() {
        let file = bulkFileEl.files && bulkFileEl.files[0];
        bulkFileEl.value = '';
        if (!file)
            return;

        let formData = new FormData();
        formData.append('file', file, file.name || 'users.csv');

        Utils.xhr.post(
            window.warpGlobals.URLs['usersBulk'],
            formData,
            {toastOnSuccess: false, errorOnFailure: false})
        .then(function(value) {
            table.replaceData();
            showBulkResult(value.response);
        }).catch(function(value) {
            let reason = value.response && value.response.reason;
            let msg = reason && TR.has('bulkImport.' + reason)
                ? TR('bulkImport.' + reason)
                : (value.errorMsg || String(value));
            WarpModal.getInstance().open(TR("Error"), msg);
        });
    }, {signal: ctx.signal});

    return function unmount() {
        table.destroy();
    };
}

export default { html, mount };
