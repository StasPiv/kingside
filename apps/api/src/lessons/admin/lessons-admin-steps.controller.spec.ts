import { LessonsAdminStepsController } from './lessons-admin-steps.controller';

describe('LessonsAdminStepsController (KS-1969)', () => {
  let service: any;
  let controller: LessonsAdminStepsController;
  const lessonId = '00000000-0000-4000-a000-000000000001';
  const stepId = '00000000-0000-4000-a000-000000000002';

  beforeEach(() => {
    service = {
      createStep: jest.fn().mockResolvedValue({ id: stepId }),
      updateStep: jest.fn().mockResolvedValue({ id: stepId }),
      deleteStep: jest.fn().mockResolvedValue(undefined),
      reorderSteps: jest.fn().mockResolvedValue(undefined),
    };
    controller = new LessonsAdminStepsController(service);
  });

  it('POST /lessons/:lessonId/steps → service.createStep(lessonId, dto)', async () => {
    const dto = { type: 'text', payload: { type: 'text', bodyMarkdown: '# Hi' } };
    await controller.create(lessonId, dto as any);
    expect(service.createStep).toHaveBeenCalledWith(lessonId, dto);
  });

  it('PATCH /steps/:id → service.updateStep(id, dto)', async () => {
    await controller.update(stepId, { order: 2 } as any);
    expect(service.updateStep).toHaveBeenCalledWith(stepId, { order: 2 });
  });

  it('DELETE /steps/:id → service.deleteStep(id)', async () => {
    await controller.delete(stepId);
    expect(service.deleteStep).toHaveBeenCalledWith(stepId);
  });

  it('POST /lessons/:lessonId/steps/reorder → service.reorderSteps(lessonId, dto)', async () => {
    await controller.reorder(lessonId, { ids: ['a', 'b'] } as any);
    expect(service.reorderSteps).toHaveBeenCalledWith(lessonId, { ids: ['a', 'b'] });
  });
});
