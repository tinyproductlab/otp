/**
 * 长按拖动排序
 *
 * 小程序没有现成的列表拖排组件。movable-view 能拖，但它要求父容器是
 * movable-area、且尺寸固定，套进现有的 scroll-view 列表里会把布局搅乱。
 * 所以这里用普通 view + touch 事件自己算：被抓起的那张卡片跟手做
 * translateY，越过半个行高就和相邻项换位。
 *
 * 只在「手动排序」模式下启用 —— 其他排序方式下顺序由规则决定，
 * 拖动没有意义，长按仍然走原来的操作表。
 *
 * 行高从真实 DOM 量，不写死：三个列表(首页 OTP、TOTP 列表、静态密码账本)
 * 卡片高度不一样，主题和字号也会影响。量不到时退回一个保守默认值，
 * 拖动仍能用，只是换位阈值不那么准。
 */

const DEFAULT_ROW_HEIGHT = 96; // px，量不到时的兜底

/**
 * @param {object} options
 * @param {string} options.selector   列表项的选择器，用于测量行高，如 '.home-token'
 * @param {string} options.listKey    页面 data 里数组字段名，如 'tokens'
 * @param {(ids: string[]) => Promise} options.persist  松手后写库
 */
function createDragSort(options) {
  const selector = options.selector;
  const listKey = options.listKey;
  const persist = options.persist;

  let rowHeight = 0;
  let dragging = null; // { id, index, startY, offset }

  /** 量一次行高。列表渲染完之后调用；失败不阻断，用兜底值。 */
  function measure(page) {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || !wx.createSelectorQuery) {
        rowHeight = rowHeight || DEFAULT_ROW_HEIGHT;
        resolve(rowHeight);
        return;
      }
      wx.createSelectorQuery().in(page).selectAll(selector).boundingClientRect((rects) => {
        if (Array.isArray(rects) && rects.length >= 2) {
          // 用相邻两项的间距，这样自然把外边距算进去
          rowHeight = Math.abs(rects[1].top - rects[0].top) || rects[0].height;
        } else if (Array.isArray(rects) && rects.length === 1 && rects[0].height) {
          rowHeight = rects[0].height;
        }
        rowHeight = rowHeight || DEFAULT_ROW_HEIGHT;
        resolve(rowHeight);
      }).exec();
    });
  }

  const isDragging = () => !!dragging;
  const draggingId = () => (dragging ? dragging.id : '');

  /**
   * 长按抓起。
   * @returns {object|null} 要 setData 的补丁；不该抓起时返回 null
   */
  function start(list, id, touch) {
    const index = list.findIndex((row) => row.id === id);
    if (index < 0) return null;
    dragging = { id, index, startY: touch ? touch.clientY : 0, offset: 0 };
    return { dragId: id, dragOffset: 0 };
  }

  /**
   * 跟手移动。跨过半个行高就换位。
   * @returns {object|null} setData 补丁；没有变化时返回 null
   */
  function move(list, touch) {
    if (!dragging || !touch) return null;
    const height = rowHeight || DEFAULT_ROW_HEIGHT;
    let offset = touch.clientY - dragging.startY;

    // 可能一次滑过好几行，用 while 逐格换，不能只判断一次
    let index = dragging.index;
    let next = list;
    let swapped = false;
    while (offset > height / 2 && index < next.length - 1) {
      next = next.slice();
      const tmp = next[index];
      next[index] = next[index + 1];
      next[index + 1] = tmp;
      index += 1;
      offset -= height;
      dragging.startY += height;
      swapped = true;
    }
    while (offset < -height / 2 && index > 0) {
      next = next.slice();
      const tmp = next[index];
      next[index] = next[index - 1];
      next[index - 1] = tmp;
      index -= 1;
      offset += height;
      dragging.startY -= height;
      swapped = true;
    }

    dragging.index = index;
    dragging.offset = offset;

    const patch = { dragOffset: offset };
    if (swapped) patch[listKey] = next;
    return patch;
  }

  /**
   * 松手：落位并写库。
   * @returns {{patch: object, save: Promise}}
   */
  function end(list) {
    if (!dragging) return { patch: null, save: Promise.resolve() };
    dragging = null;
    const ids = list.map((row) => row.id);
    return {
      patch: { dragId: '', dragOffset: 0 },
      save: persist ? persist(ids) : Promise.resolve(),
    };
  }

  /** 中途取消(比如页面隐藏)，不写库 */
  function cancel() {
    dragging = null;
    return { dragId: '', dragOffset: 0 };
  }

  return { measure, start, move, end, cancel, isDragging, draggingId,
    _internal: { rowHeight: () => rowHeight, setRowHeight: (h) => { rowHeight = h; } } };
}

module.exports = { createDragSort, DEFAULT_ROW_HEIGHT };
