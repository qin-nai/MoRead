package com.moread;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.widget.LinearLayout;

/**
 * 树里的一行，负责把属于自己那段连接线画出来。
 *
 * 为什么是"每行各画各的"，而不是每层套一个容器：
 * 行与行之间的竖线要连成一条，靠嵌套布局就得让子容器反向叠进父行的左边距里，
 * 改一次缩进要动三层。摊平成一列行、每行按自己的层级和上下邻居画线，
 * 几何关系一眼能算清；折叠时也只是把后代的可见性收掉。
 *
 * 几何照 Web 层那份目录结构图（assets/reader/css/ui.css 里的 .tnode）：
 * 每层缩进 INDENT，第 i 层的竖线画在左边距里 x = i*INDENT 处，
 * 本行的横线从竖线拉到内容起始处。目录的横线到此为止（那里站着一个折叠箭头），
 * 文件多拉过箭头那一格——文件那格是空的，横线停在半路看着像断了。
 */
public class TreeRow extends LinearLayout {

    /** 每层缩进。和 Web 层结构图的 16px 同值，两处观感才是同一套 */
    private static final float INDENT_DP = 16f;
    /** 折叠箭头 16dp + 与图标的间距 6dp。文件没有箭头，横线要跨过这一格 */
    private static final float CHEV_SLOT_DP = 22f;

    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);

    private int depth;
    /** 第 i 位是 1 ⇒ 在 (i+1)*INDENT 处画一条贯穿整行的竖线（表示那一层还有后续兄弟） */
    private int mask;
    private boolean first = true;
    private boolean last = true;
    private boolean dir;

    public TreeRow(Context context, AttributeSet attrs) {
        super(context, attrs);
        line.setStyle(Paint.Style.STROKE);
        line.setStrokeWidth(dp(1));
        line.setColor(context.getColor(R.color.border_strong));
        // ViewGroup 默认不调 onDraw，要显式打开
        setWillNotDraw(false);
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
    }

    /**
     * @param depth 第几层（根目录下的第一层是 0，那层不带连接线，因为没有可见的父行）
     * @param mask  见 {@link #mask}
     * @param first 是不是同级里的第一个（是的话竖线不往上连）
     * @param last  是不是同级里的最后一个（是的话竖线不往下连）
     * @param dir   是不是目录。只影响横线拉多长
     */
    void setConnectors(int depth, int mask, boolean first, boolean last, boolean dir) {
        this.depth = depth;
        this.mask = mask;
        this.first = first;
        this.last = last;
        this.dir = dir;
        setPaddingStart((int) (dp(INDENT_DP) * (depth + 1)));
        invalidate();
    }

    private void setPaddingStart(int px) {
        setPaddingRelative(px, getPaddingTop(), getPaddingEnd(), getPaddingBottom());
    }

    /** 路径上的祖先有没有在这一行里留下竖线，渲染前问一下就够了 */
    static int childMask(int mask, int depth, boolean last) {
        // 第 depth 层的节点把自己的竖线留给后代，位置在 depth*INDENT，
        // 对应 mask 的第 depth-1 位。根那一层（depth 0）自身不带连接线，不留
        if (depth < 1 || last) return mask;
        return mask | (1 << (depth - 1));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float h = getHeight();
        float mid = h / 2f;
        float ind = dp(INDENT_DP);

        // 祖先留下的竖线：贯穿整行，只有它那一层还有后续兄弟才会画下来
        for (int i = 0; i <= depth - 2; i++) {
            if ((mask & (1 << i)) == 0) continue;
            float x = (i + 1) * ind;
            canvas.drawLine(x, 0, x, h, line);
        }

        if (depth < 1) return;   // 顶层没有可见的父行，不画

        float x = depth * ind;
        // 自己这段竖线：第一个孩子不往上连，最后一个不往下连。
        // 独子时上下都从中间出发，长度为零，只剩一横——正是想要的
        canvas.drawLine(x, first ? mid : 0, x, last ? mid : h, line);

        float end = (depth + 1) * ind + (dir ? 0 : dp(CHEV_SLOT_DP));
        canvas.drawLine(x, mid, end, mid, line);
    }
}
