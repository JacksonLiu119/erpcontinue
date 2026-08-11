(function () {
  const list = document.querySelector('#basicDataSources');
  if (!list) return;

  const selectFirstSourceWhenNeeded = () => {
    const buttons = list.querySelectorAll('[data-basic-key]');
    if (buttons.length && !list.querySelector('.active')) buttons[0].click();
  };

  new MutationObserver(selectFirstSourceWhenNeeded).observe(list, { childList: true });

  const canvas = document.querySelector('#canvas');
  if (canvas) {
    new MutationObserver(() => {
      const departmentForm = document.querySelector('#sourceDepartmentForm');
      if (departmentForm && !departmentForm.dataset.loaded && typeof window.loadShDepartments === 'function') {
        departmentForm.dataset.loaded = '1';
        window.loadShDepartments();
      }
      const employeeForm = document.querySelector('#sourceEmployeeForm');
      if (employeeForm && !employeeForm.dataset.loaded && typeof window.loadShEmployees === 'function') {
        employeeForm.dataset.loaded = '1';
        window.loadShEmployees();
      }
    }).observe(canvas, { childList: true, subtree: true });
  }

  document.addEventListener('click', (event) => {
    if (event.target.id === 'sourceWarehouseCancel') {
      setTimeout(() => {
        const input = document.querySelector('#sourceWarehouseForm [name="warehouse_code"]');
        if (input) input.readOnly = false;
      }, 0);
    }
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'sourceWarehouseForm') {
      setTimeout(() => {
        const input = event.target.elements.warehouse_code;
        if (input && !event.target.dataset.editCode) input.readOnly = false;
      }, 300);
    }
  });
})();
